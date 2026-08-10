import { ask } from '../utils/ask.ts';
import terminalImage from 'term-img';
import sharp from 'sharp';
import fs from 'fs-extra';
import path from 'path';
import { useSpinners } from '../utils/spinners.ts';
import chalk from 'chalk';
import { $ } from 'zx';
import { PDFDocument } from 'pdf-lib';
import { cropAlternativesRemote, isRemoteServiceEnabled } from './remote-image-service.js';
import { createLogger } from '../utils/logger.ts';

const { showSpinner, log } = useSpinners('images', chalk.white);
const debug = createLogger('crop');

const output_directory = 'output/';
const MAX_IMAGE_SIZE = 10 * 1000 * 1000; // slightly under 10MB

const slugifyFilenamePart = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// Sports cards are 2.5" x 3.5". Accept either orientation.
const CARD_ASPECT_PORTRAIT = 2.5 / 3.5; // ~0.714
const CARD_ASPECT_LANDSCAPE = 3.5 / 2.5; // ~1.400
const ASPECT_TOLERANCE = 0.22; // ±22%, matches card_cropper_sam.py
const MIN_CARD_SIDE_PX = 300; // reject strips / thumbnails
const MIN_AREA_FRACTION = 0.15; // crop must cover >=15% of source area (rejects stats-block sub-regions)

async function isPlausibleCardCrop(imagePath, sourceArea) {
  const meta = await sharp(imagePath).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  if (w < MIN_CARD_SIDE_PX || h < MIN_CARD_SIDE_PX) {
    return { ok: false, reason: `too small ${w}x${h}` };
  }
  const ratio = w / h;
  const portraitErr = Math.abs(ratio - CARD_ASPECT_PORTRAIT) / CARD_ASPECT_PORTRAIT;
  const landscapeErr = Math.abs(ratio - CARD_ASPECT_LANDSCAPE) / CARD_ASPECT_LANDSCAPE;
  const err = Math.min(portraitErr, landscapeErr);
  if (err > ASPECT_TOLERANCE) {
    return { ok: false, reason: `aspect ${ratio.toFixed(3)} off by ${(err * 100).toFixed(0)}%` };
  }
  if (sourceArea > 0) {
    const fraction = (w * h) / sourceArea;
    if (fraction < MIN_AREA_FRACTION) {
      return { ok: false, reason: `covers only ${(fraction * 100).toFixed(1)}% of source` };
    }
  }
  return { ok: true };
}

function getOutputFile(listing, setInfo, imageNumber) {
  const category = setInfo.metadata;
  let outputLocation = `${output_directory}${category.sport}/${category.year}/${category.setName}`;
  if (category.insert) {
    outputLocation = `${outputLocation}/${category.insert}`;
  }
  if (category.parallel) {
    outputLocation = `${outputLocation}/${category.parallel}`;
  }
  const cardSlug = slugifyFilenamePart(listing.metadata.cardNumber);
  const playerSlug = listing.product.metadata.player.map(slugifyFilenamePart).filter(Boolean).join('-');
  const outputFile = `${outputLocation}/${cardSlug}-${playerSlug}-${imageNumber}.jpg`;
  return { outputLocation, outputFile };
}

export const prepareImageFile = async (image, listing, setInfo, imageNumber, useImageFirst = false) => {
  const { outputLocation, outputFile } = getOutputFile(listing, setInfo, imageNumber);
  return cropImage(image, listing, outputLocation, outputFile, true, useImageFirst);
};

export const cropImage = async (
  image,
  listing,
  outputLocation,
  outputFile,
  useMaxSize = true,
  useImageFirst = false,
  nonInteractive = false,
) => {
  const { update, error, finish } = showSpinner('crop', 'Preparing Image');
  let input = image;
  // let rotation = await ask('Rotate', false);
  let rotate;
  // if (isYes(rotation)) {
  //   rotate = -90
  // } else if (isNaN(rotation)) {
  //   rotate = 0;
  // } else {
  //   rotate = rotation || 0;
  // }
  //if the output file already exists, skip it
  if (fs.existsSync(outputFile)) {
    // Already cropped — skip silently
  } else {
    await $`mkdir -p ${outputLocation}`;

    if (fs.existsSync(outputFile)) {
      fs.removeSync(outputFile);
    }

    const inputStem = path.basename(image, path.extname(image));
    const uniqueId = `${inputStem}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempDirectory = `/tmp/cardlister/${uniqueId}`;
    await fs.ensureDir(tempDirectory);
    let tempImage = `${tempDirectory}/temp.jpg`;

    if (rotate) {
      await $`magick ${input} -rotate ${rotate} ${tempDirectory}/temp.rotated.jpg`;
      input = `${tempDirectory}/temp.rotated.jpg`;
    }

    let sourceArea = 0;
    try {
      const srcMeta = await sharp(input).metadata();
      sourceArea = (srcMeta.width || 0) * (srcMeta.height || 0);
    } catch (e) {
      debug(`could not read source metadata for area-fraction gate: ${e?.message || e}`);
    }

    // ── Remote /crop alternatives (lazy, single API call shared by all strategies) ──
    // Heavy crop strategies (SAM, Haiku bbox, PIL trim variants) run on the
    // preprocess service rather than on the developer's laptop. The four
    // entries below all share one /crop POST: the first to fire kicks off the
    // upload, the rest await the same promise.
    let remoteCropPromise = null;
    const STRATEGY_NAMES = ['pil_trim_dark', 'pil_trim_light', 'sam', 'haiku_bbox'];
    const ensureRemoteCrops = async () => {
      if (!isRemoteServiceEnabled()) return null;
      if (!remoteCropPromise) {
        remoteCropPromise = cropAlternativesRemote(input).catch((e) => {
          debug(`remote /crop failed: ${e?.message || e}`);
          return null;
        });
      }
      return remoteCropPromise;
    };
    const remoteAttempt = (strategy) => ({
      name: `remote:${strategy}`,
      fn: async () => {
        const alternatives = await ensureRemoteCrops();
        if (!alternatives) return false;
        const entry = alternatives.find((a) => a.strategy === strategy);
        if (!entry) {
          debug(`remote /crop missing strategy ${strategy}`);
          return false;
        }
        if (!entry.bytes) {
          if (entry.error) debug(`remote ${strategy} returned error: ${entry.error}`);
          return false;
        }
        tempImage = `${tempDirectory}/remote-${strategy}.jpg`;
        await fs.writeFile(tempImage, entry.bytes);
        return true;
      },
    });

    const cropAttempts = [
      {
        name: 'CardCropper.rotate',
        fn: async () => {
          tempImage = `${tempDirectory}/CC.rotate.jpg`;
          return await $`./CardCropper.rotate ${input} ${tempImage}`.quiet();
        },
      },
      {
        name: 'sharp.extract',
        fn: async () => {
          tempImage = `${tempDirectory}/sharp.extract.jpg`;
          return listing?.crop?.left ? await sharp(input).extract(listing.crop).toFile(tempImage) : false;
        },
      },
      {
        name: 'CardCropper',
        fn: async () => {
          tempImage = `${tempDirectory}/CC.crop.jpg`;
          return await $`./CardCropper ${input} ${tempImage}`.quiet();
        },
      },
      // Heavy alternatives — run on the preprocess service via /crop.
      ...STRATEGY_NAMES.map(remoteAttempt),
      {
        name: 'manual',
        fn: async () => {
          tempImage = `${tempDirectory}/manual.jpg`;
          const openCommand = await $`cp ${input} ${tempImage}; open -Wn ${tempImage}`;
          // eslint-disable-next-line no-undef
          process.on('SIGINT', () => openCommand?.kill());
          return openCommand;
        },
      },
      // Last-resort: if every cropper failed the aspect/area gate, hand off
      // the raw uncropped image so downstream OCR has something to work with.
      {
        name: 'passthrough',
        fn: async () => {
          tempImage = `${tempDirectory}/passthrough.jpg`;
          log(`  ⚠ all crop attempts failed aspect gate; falling back to uncropped ${path.basename(image)}`);
          return $`cp ${input} ${tempImage}`;
        },
      },
    ];
    // Skip manual fallback in non-interactive mode
    const attempts = nonInteractive
      ? cropAttempts.filter(a => a.name !== 'manual')
      : cropAttempts;
    if (useImageFirst) {
      attempts.unshift({
        name: 'copy',
        fn: async () => {
          tempImage = `${tempDirectory}/copy.jpg`;
          return $`cp ${input} ${tempImage}`;
        },
      });
    }
    let found = false;
    let cropMethod = null;
    let i = 0;
    while (!found && i < attempts.length) {
      const { name, fn } = attempts[i];
      debug(`starting attempt ${i + 1}/${attempts.length}: ${name}`);
      try {
        update(`Attempting crop ${i + 1}/${attempts.length}: ${name}`);
        const cropped = await fn();
        if (cropped) {
          // Aspect-ratio gate only applies to non-interactive auto-crop. When
          // the user is reviewing each crop, they decide if it looks right —
          // a gate that rejects valid crops just makes us cycle through every
          // strategy down to the Photoshop fallback.
          if (nonInteractive && name !== 'copy' && name !== 'passthrough') {
            const check = await isPlausibleCardCrop(tempImage, sourceArea);
            if (!check.ok) {
              debug(`attempt ${name} rejected: ${check.reason}`);
              try { await fs.remove(tempImage); } catch { /* ignore */ }
              i++;
              continue;
            }
          }
          debug(`attempt ${name} succeeded → ${tempImage}`);

          if (nonInteractive) {
            // Auto-accept the first successful crop
            debug(`auto-accepting ${name} (non-interactive)`);
            found = true;
            cropMethod = name;
          } else if (useImageFirst) {
            debug(`auto-accepting ${name} (pre-cropped / useImageFirst)`);
            found = true;
            cropMethod = name;
          } else {
            try {
              // Try to display the image using term-img first
              const imageOutput = await terminalImage(tempImage, { height: 25 });
              log('  ' + imageOutput);
            } catch (error) {
              // If term-img fails, show image info
              log('  📷 [Image display failed, showing details]');
              log(`     File: ${tempImage.split('/').pop()}`);

              // Try to get image dimensions using sharp
              try {
                const metadata = await sharp(tempImage).metadata();
                log(`     Dimensions: ${metadata.width} x ${metadata.height}`);
                log(`     Format: ${metadata.format}`);
                log(`     Size: ${metadata.size ? (metadata.size / 1024 / 1024).toFixed(2) : 'Unknown'} MB`);
              } catch (sharpError) {
                log('     [Could not read image metadata]');
              }
            }

            {
              debug(`prompting user after ${name}`);
              found = await ask(`Did Image ${path.basename(image)} render correct?`, true);
              debug(`user answered: ${found}`);
              if (found) cropMethod = name;
            }
          }
        } else {
          debug(`attempt ${name} returned false (no crop found)`);
          found = false;
        }
      } catch (e) {
        debug(`attempt ${name} threw: ${e?.message || e}`);
        if (e?.stderr) debug(`  stderr: ${String(e.stderr).trim()}`);
        if (e?.stdout) debug(`  stdout: ${String(e.stdout).trim()}`);
        if (e?.exitCode != null) debug(`  exitCode: ${e.exitCode}`);
      }
      i++;
    }

    if (found) {
      const buffer = await sharp(tempImage).toBuffer();
      if (useMaxSize && buffer.length > MAX_IMAGE_SIZE) {
        const compressionRatio = MAX_IMAGE_SIZE / buffer.length;
        const outputQuality = Math.floor(compressionRatio * 100);
        await sharp(buffer).jpeg({ quality: outputQuality }).toFile(outputFile);
        await $`rm ${tempImage}`;
      } else {
        await $`mv ${tempImage} ${outputFile}`;
      }
      await fs.remove(tempDirectory);
    } else {
      const e = new Error('Failed to crop image');
      error(e);
      throw e;
    }
  }

  finish();
  return outputFile;
};

const DPI = 600;

export const resizeImageForDisplay = async (imagePath) => {
  const tempDirectory = '/tmp/cardlister';
  await fs.ensureDir(tempDirectory);
  const ext = path.extname(imagePath) || '.jpg';
  const basename = path.basename(imagePath, ext);
  const tempPath = path.join(tempDirectory, `preview-${basename}-${Date.now()}${ext}`);
  const metadata = await sharp(imagePath).metadata();
  await sharp(imagePath)
    .resize(Math.floor((metadata.width || 1000) * 0.5), Math.floor((metadata.height || 1400) * 0.5))
    .toFile(tempPath);
  return tempPath;
};

export async function buildPDF(images, outputFileName) {
  const { update, error, finish } = showSpinner('resize', 'Building PDF');
  let output;
  try {
    const pdfDoc = await PDFDocument.create();
    
    // Group images by index: even indices (0,2,4...) are fronts, odd indices (1,3,5...) are backs
    const frontImages = [];
    const backImages = [];
    
    images.forEach((image, index) => {
      if (index % 2 === 0) {
        frontImages.push(image);
      } else {
        backImages.push(image);
      }
    });

    const resize = async (image) => {
      // Get image metadata to check orientation
      const metadata = await sharp(image).metadata();

      // If image is landscape (width > height), rotate it to portrait
      let processedImage = sharp(image);
      if (metadata.width > metadata.height) {
        processedImage = processedImage.rotate(90);
      }

      // Resize to standard card dimensions
      return await processedImage
        .resize(750, 1050, { fit: 'fill' }) // Resize to 750x1050 pixels
        .toBuffer();
    };

    const cardWidth = 2.5 * DPI; // 2.5 inches in points
    const cardHeight = 3.5 * DPI; // 3.5 inches in points
    const marginX = 0.125 * DPI; // 0.125 inch margin between cards
    const marginY = 0.125 * DPI; // 0.125 inch margin between rows
    const pageMargin = 0.25 * DPI; // 0.25 inch page margin

    // Calculate total grid width and center the grid
    const cardsPerRow = 3;
    const totalGridWidth = cardsPerRow * cardWidth + (cardsPerRow - 1) * marginX;
    const totalGridHeight = 3 * cardHeight + 2 * marginY;
    const pageWidth = 8.5 * DPI;
    const pageHeight = 11 * DPI;
    const startX = (pageWidth - totalGridWidth) / 2;
    const startY = pageHeight - pageMargin - totalGridHeight;

    // Helper function to add images to pages
    const addImagesToPages = async (imageList, pageType) => {
      let page = pdfDoc.addPage([8.5 * DPI, 11 * DPI]); // 8.5" x 11" page
      let x = startX;
      let y = startY;

      for (let i = 0; i < imageList.length; i++) {
        update(`Adding ${pageType} Image ${i + 1}/${imageList.length}`);
        log(`Adding ${imageList[i]}`);
        const resizedImage = await resize(imageList[i]);
        const img = await pdfDoc.embedJpg(resizedImage);

        page.drawImage(img, {
          x,
          y,
          width: cardWidth,
          height: cardHeight,
        });

        x += cardWidth + marginX;
        if ((i + 1) % cardsPerRow === 0) {
          x = startX;
          y += cardHeight + marginY;
        }

        // If we reach the bottom, create a new page
        if ((i + 1) % 9 === 0 && i !== imageList.length - 1) {
          page = pdfDoc.addPage([8.5 * DPI, 11 * DPI]);
          x = startX;
          y = startY;
        }
      }
    };

    // Add front images first
    if (frontImages.length > 0) {
      await addImagesToPages(frontImages, 'Front');
    }

    // Add back images on new page(s) - reverse each row (groups of 3) for proper back-to-back alignment
    if (backImages.length > 0) {
      const cardsPerRow = 3;
      const reversedBackImages = [];
      
      // Process back images in groups of 3 and reverse each group
      for (let i = 0; i < backImages.length; i += cardsPerRow) {
        const row = backImages.slice(i, i + cardsPerRow);
        reversedBackImages.push(...row.reverse());
      }
      
      await addImagesToPages(reversedBackImages, 'Back');
    }

    const pdfBytes = await pdfDoc.save();
    output = `/tmp/${outputFileName}.pdf`;
    fs.writeFileSync(output, pdfBytes);
    finish();
  } catch (e) {
    error(e);
    throw e;
  }
  return output;
}

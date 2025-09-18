import { ask } from '../utils/ask.ts';
import terminalImage from 'term-img';
import sharp from 'sharp';
import fs from 'fs-extra';
import { useSpinners } from '../utils/spinners.ts';
import chalk from 'chalk';
import { $ } from 'zx';
import { PDFDocument } from 'pdf-lib';

const { showSpinner, log } = useSpinners('images', chalk.white);

const output_directory = 'output/';
const MAX_IMAGE_SIZE = 10 * 1000 * 1000; // slightly under 10MB

function getOutputFile(listing, setInfo, imageNumber) {
  const category = setInfo.metadata;
  let outputLocation = `${output_directory}${category.sport}/${category.year}/${category.setName}`;
  if (category.insert) {
    outputLocation = `${outputLocation}/${category.insert}`;
  }
  if (category.parallel) {
    outputLocation = `${outputLocation}/${category.parallel}`;
  }
  const outputFile = `${outputLocation}/${listing.metadata.cardNumber}-${listing.product.metadata.player.reduce(
    (names, name) => `${names}-${name.toLowerCase().replace(/\s/g, '-')}`,
  )}-${imageNumber}.jpg`;
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
    log('Image already exists, skipping');
  } else {
    await $`mkdir -p ${outputLocation}`;

    if (fs.existsSync(outputFile)) {
      fs.removeSync(outputFile);
    }

    const tempDirectory = '/tmp/cardlister';
    await fs.ensureDir(tempDirectory);
    let tempImage = `${tempDirectory}/temp.jpg`;

    if (rotate) {
      await $`magick ${input} -rotate ${rotate} ${tempDirectory}/temp.rotated.jpg`;
      input = `${tempDirectory}/temp.rotated.jpg`;
    }

    const cropAttempts = [
      async () => {
        tempImage = `${tempDirectory}/CC.rotate.jpg`;
        return await $`./CardCropper.rotate ${input} ${tempImage}`;
      },
      async () => {
        tempImage = `${tempDirectory}/sharp.extract.jpg`;
        return listing?.crop?.left ? await sharp(input).extract(listing.crop).toFile(tempImage) : false;
      },
      async () => {
        tempImage = `${tempDirectory}/sharp.trimp.jpg`;
        return await sharp(input).trim({ threshold: 50 }).toFile(tempImage);
      },
      async () => {
        tempImage = `${tempDirectory}/CC.crop.jpg`;
        return await $`./CardCropper ${input} ${tempImage}`;
      },
      async () => {
        tempImage = `${tempDirectory}/manual.jpg`;
        const openCommand = await $`cp ${input} ${tempImage}; open -Wn ${tempImage}`;
        // eslint-disable-next-line no-undef
        process.on('SIGINT', () => openCommand?.kill());
        return openCommand;
      },
    ];
    if (useImageFirst) {
      cropAttempts.unshift(async () => {
        tempImage = `${tempDirectory}/copy.jpg`;
        return $`cp ${input} ${tempImage}`;
      });
    }
    let found = false;
    let i = 0;
    while (!found && i < cropAttempts.length) {
      try {
        update(`Attempting crop ${i}/${cropAttempts.length}`);
        const cropped = await cropAttempts[i]();
        if (cropped) {
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

          found = await ask('Did Image render correct?', true);
        } else {
          found = false;
        }
      } catch (e) {
        log(e);
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

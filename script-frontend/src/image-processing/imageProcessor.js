import { ask } from '../utils/ask.ts';
import terminalImage from 'terminal-image';
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
  const outputFile = `${outputLocation}/${listing.product.metadata.cardNumber}-${listing.product.metadata.player.reduce(
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
          log('  ' + (await terminalImage.file(tempImage, { height: 25 })));
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
    let page = pdfDoc.addPage([8.5 * DPI, 11 * DPI]); // 8.5" x 11" page

    const resize = async (image) =>
      await sharp(image)
        .resize(750, 1050, { fit: 'fill' }) // Resize to 750x1050 pixels
        .toBuffer();

    const cardWidth = 2.6 * DPI; // 2.5 inches in points
    const cardHeight = 3.6 * DPI; // 3.5 inches in points
    const marginX = 0.33 * DPI; // 0.5 inch margin
    const marginY = 0.16 * DPI;

    let x = marginX;
    let y = 11 * DPI - marginY - cardHeight;

    for (let i = 0; i < images.length; i++) {
      update(`Adding Image ${i + 1}/${images.length}`);
      log(`Adding ${images[i]}`);
      const resizedImage = await resize(images[i]);
      const img = await pdfDoc.embedJpg(resizedImage);

      page.drawImage(img, {
        x,
        y,
        width: cardWidth,
        height: cardHeight,
      });

      x += cardWidth + marginX;
      if ((i + 1) % 3 === 0) {
        x = marginX;
        y -= cardHeight + marginY;
      }

      // If we reach the bottom, create a new page
      if ((i + 1) % 9 === 0 && i !== images.length - 1) {
        page = pdfDoc.addPage([8.5 * DPI, 11 * DPI]);
        x = marginX;
        y = 11 * DPI - marginY - cardHeight;
      }
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

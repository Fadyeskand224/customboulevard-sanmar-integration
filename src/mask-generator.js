'use strict';

const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');

/** Downloads an image and returns its pixel dimensions. */
async function getImageDimensions(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  const img = await loadImage(Buffer.from(res.data));
  return { width: img.width, height: img.height };
}

/**
 * Scales a template print-area rect (in the template image's own pixel
 * space, origin at image center — confirmed against Zakeke's live API
 * output) onto a differently-sized target image, by carrying over each
 * axis as a fraction of the template's own width/height. This tolerates
 * template and target having different aspect ratios, since each axis is
 * normalized independently.
 */
function scaleRect(templateRect, templateImageSize, targetImageSize) {
  const fx = templateRect.boundsX / templateImageSize.width;
  const fy = templateRect.boundsY / templateImageSize.height;
  const fw = templateRect.boundsWidth / templateImageSize.width;
  const fh = templateRect.boundsHeight / templateImageSize.height;

  return {
    boundsX: fx * targetImageSize.width,
    boundsY: fy * targetImageSize.height,
    boundsWidth: fw * targetImageSize.width,
    boundsHeight: fh * targetImageSize.height,
  };
}

/**
 * Renders a print-area mask PNG at the given image's own pixel dimensions:
 * transparent everywhere except an opaque white rectangle marking the
 * printable zone. `rect` bounds are center-origin pixel offsets, matching
 * Zakeke's own area coordinate system.
 */
function renderMaskPng(imageSize, rect) {
  const canvas = createCanvas(imageSize.width, imageSize.height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, imageSize.width, imageSize.height);

  const cx = imageSize.width / 2;
  const cy = imageSize.height / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx + rect.boundsX, cy + rect.boundsY, rect.boundsWidth, rect.boundsHeight);

  return canvas.toBuffer('image/png');
}

module.exports = { getImageDimensions, scaleRect, renderMaskPng };

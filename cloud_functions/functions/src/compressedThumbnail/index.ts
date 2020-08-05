import * as functions from "firebase-functions";
// tslint:disable-next-line: no-import-side-effect
import "../config";
import * as admin from "firebase-admin";

import * as path from "path";
import * as os from "os";
import * as fs from "fs";

import * as sharp from "sharp";
import * as imagemin from "imagemin";
import * as imageminMozjpeg from "imagemin-mozjpeg";
import imageminPngquant from "imagemin-pngquant";

import config from "../functionConfig";

const SUPPORTED_TYPES = ["image/jpeg", "image/png"];
const DEFAULT_SIZES = ["400x400", "200x200", "100x100"];
const sizes =
  Array.isArray(config) && typeof config[0] === "string"
    ? config
    : DEFAULT_SIZES;

export const FT_compressedThumbnail = functions.storage
  .object()
  .onFinalize(async (object) => {
    // Log file name, size, and content type for monitoring
    console.log(object.name, object.size, object.contentType);

    // Exit if this is triggered on a file that is not an image.
    if (!object.contentType || !SUPPORTED_TYPES.includes(object.contentType)) {
      console.log("Unsupported type", object.contentType);
      return null;
    }

    // Exit if this is already a compressed thumbnail.
    if (object.metadata?.isCompressedThumbnail) {
      console.log("This is already a compressed thumbnail", object.name);
      return null;
    }

    // Get Firebase Storage download token
    const token = object.metadata?.firebaseStorageDownloadTokens;

    const filePath = object.name!;
    const baseFileName = path.basename(filePath, path.extname(filePath));
    const tempLocalFile = path.join(
      os.tmpdir(),
      baseFileName + path.extname(filePath)
    );

    // Download file from bucket.
    const bucket = admin.storage().bucket(object.bucket);
    await bucket.file(filePath).download({ destination: tempLocalFile });

    for (const size of sizes) {
      try {
        const thumbFilePath = path.normalize(
          path.format({
            dir: path.dirname(filePath),
            name: baseFileName + "__" + size,
            ext: path.extname(filePath),
          })
        );
        const tempLocalThumbFile = path.join(
          os.tmpdir(),
          path.basename(thumbFilePath)
        );

        // Resize image to thumbnail size
        const resized = await sharp(tempLocalFile)
          .resize(
            parseInt(size.split("x")[0], 10),
            parseInt(size.split("x")[1], 10),
            {
              fit: "inside",
              withoutEnlargement: true,
            }
          )
          .toBuffer();

        // Compress the image
        const compressed = await imagemin.buffer(resized, {
          plugins: [
            imageminMozjpeg({ quality: 75 }),
            imageminPngquant({ quality: [0.6, 0.8] }),
          ],
        });
        fs.writeFileSync(tempLocalThumbFile, compressed);

        // Upload the image
        await bucket.upload(tempLocalThumbFile, {
          destination: thumbFilePath,
          metadata: {
            metadata: {
              firebaseStorageDownloadTokens: token,
              isCompressedThumbnail: true,
            },
          },
        });
        console.log(size, "thumbnail uploaded to Storage at", thumbFilePath);

        // Once the image has been converted delete the local files to free up disk space.
        fs.unlinkSync(tempLocalThumbFile);
      } catch (e) {
        console.error(`Failed to generate thumbnail size: ${size}`, e);
      }
    }

    fs.unlinkSync(tempLocalFile);

    return filePath;
  });

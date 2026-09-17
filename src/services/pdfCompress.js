const { spawn } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const config = require("../config");

/**
 * Compresses a PDF buffer by shelling out to Ghostscript (must be installed
 * on the host as the `gs` binary — see Dockerfile / nixpacks.toml in this
 * repo). Downsamples embedded images and subsets fonts; does not touch
 * text or vector content, so text stays crisp and searchable.
 *
 * Throws with `err.code === "ENOENT"` if Ghostscript isn't on PATH, so
 * callers can show a specific "not configured on this server" message
 * instead of a generic failure.
 *
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
async function compressPdf(inputBuffer) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfcompress-"));
  const inputPath = path.join(tmpDir, "input.pdf");
  const outputPath = path.join(tmpDir, "output.pdf");

  try {
    await fs.writeFile(inputPath, inputBuffer);

    await new Promise((resolve, reject) => {
      const gs = spawn("gs", [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        `-dPDFSETTINGS=${config.PDF_COMPRESS_PRESET}`,
        "-dNOPAUSE",
        "-dBATCH",
        "-dQUIET",
        `-sOutputFile=${outputPath}`,
        inputPath,
      ]);

      let stderr = "";
      gs.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      // e.g. ENOENT when the `gs` binary isn't installed on this host.
      gs.on("error", reject);

      gs.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Ghostscript exited with code ${code}: ${stderr}`));
      });
    });

    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { compressPdf };

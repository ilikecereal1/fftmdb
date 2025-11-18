import { readdir } from "node:fs/promises";
import fs from "node:fs";
import https from "https";
import { pipeline } from "stream/promises";
import path from "path";

const dataPath = "new-data";
const imagePath = "images";

async function download(url) {
  return new Promise(async (onSuccess) => {
    https.get(url, async (res) => {
      let fileName = url.split("/").pop();
      const fileWriteStream = fs.createWriteStream(
        path.join("./", imagePath, fileName),
        {
          autoClose: true,
          flags: "w",
        }
      );
      await pipeline(res, fileWriteStream);
      console.log("succesfully downloaded", url);
      onSuccess("success");
    });
  });
}

try {
  let files = await readdir("./" + dataPath, { recursive: true });
  console.log(files);
  files.forEach((file) => {
    fs.readFile(`${dataPath}\\${file}`, "utf-8", (err, data) => {
      if (err) {
        console.error(err);
        return;
      }
      const jsonData = JSON.parse(data);
      if (jsonData.poster_path) {
        jsonData.forEach(({ poster_path }) => {
          download("https://image.tmdb.org/t/p/original" + poster_path);
        });
      } else {
        jsonData.forEach(({ backdrop_path }) => {
          download("https://image.tmdb.org/t/p/original" + backdrop_path);
        });
      }
    });
  });
} catch (err) {
  console.error(err);
}

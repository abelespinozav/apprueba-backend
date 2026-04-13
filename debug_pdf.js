const pdfParse = require('pdf-parse');
const fs = require('fs');
const buffer = fs.readFileSync('/Users/abelespinozaviguera/Downloads/$value.pdf');
pdfParse(buffer).then(data => {
  console.log(data.text);
});

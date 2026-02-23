import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { resolveCashFlowSheetPath } from '../services/excel.js';

function buildZip({ sheets }) {
  const zip = new JSZip();

  const sheetsXml = sheets
    .map(
      ({ name, rId }) =>
        `<sheet name="${name}" sheetId="1" r:id="${rId}"/>`
    )
    .join('');

  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
  <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
    <sheets>${sheetsXml}</sheets>
  </workbook>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    ${sheets
      .map(
        ({ rId, target }) =>
          `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`
      )
      .join('')}
  </Relationships>`;

  zip.file('xl/workbook.xml', workbookXml);
  zip.file('xl/_rels/workbook.xml.rels', relsXml);
  sheets.forEach(({ target }) => {
    zip.file(`xl/${target}`, '<worksheet />');
  });

  return zip;
}

test('resolveCashFlowSheetPath picks explicit year', async () => {
  const zip = buildZip({
    sheets: [
      { name: '2026', rId: 'rId1', target: 'worksheets/sheet1.xml' },
      { name: '2025', rId: 'rId2', target: 'worksheets/sheet2.xml' },
    ],
  });

  const path = await resolveCashFlowSheetPath(zip, '2025');
  assert.equal(path, 'xl/worksheets/sheet2.xml');
});

test('resolveCashFlowSheetPath defaults to latest numeric year', async () => {
  const zip = buildZip({
    sheets: [
      { name: '2024', rId: 'rId1', target: 'worksheets/sheet1.xml' },
      { name: 'Yearly', rId: 'rId2', target: 'worksheets/sheet2.xml' },
      { name: '2026', rId: 'rId3', target: 'worksheets/sheet3.xml' },
    ],
  });

  const path = await resolveCashFlowSheetPath(zip);
  assert.equal(path, 'xl/worksheets/sheet3.xml');
});

test('resolveCashFlowSheetPath throws when year missing', async () => {
  const zip = buildZip({
    sheets: [
      { name: 'Yearly', rId: 'rId1', target: 'worksheets/sheet1.xml' },
    ],
  });

  await assert.rejects(
    () => resolveCashFlowSheetPath(zip, '2026'),
    /Cash Flow sheet "2026" not found/
  );
});

import { readFile, writeFile } from 'fs/promises';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';

const MONTHS = ['GEN','FEB','MAR','APR','MAG','GIU','LUG','AGO','SET','OTT','NOV','DIC'];
const TX_HEADERS = ['Date','Type','Transaction','Notes','IBAN','Inflow','Outflow','Balance','Cash flow','Conments'];

function tableDisplayName(monthIndex) {
  // Mirrors the live convention: GEN→Table4, FEB→Table42, MAR→Table426, …
  const digits = ['4','2','6','8','10','12','14','16','18','20','22','24'];
  return 'Table' + digits.slice(0, monthIndex + 1).join('');
}

function tableXmlForMonth(monthIndex, lastDataRow, tableId) {
  const lastRow = lastDataRow + 1; // totals row included
  const name = tableDisplayName(monthIndex);
  const cols = TX_HEADERS.map((h, i) => {
    const id = i + 1;
    if (h === 'Inflow') {
      return `<tableColumn id="${id}" name="Inflow" totalsRowFunction="custom"><totalsRowFormula>SUM(F2:F${lastDataRow})</totalsRowFormula></tableColumn>`;
    }
    if (h === 'Outflow') {
      return `<tableColumn id="${id}" name="Outflow" totalsRowFunction="custom"><totalsRowFormula>SUM(G2:G${lastDataRow})</totalsRowFormula></tableColumn>`;
    }
    if (h === 'Balance') {
      return `<tableColumn id="${id}" name="Balance" totalsRowFunction="custom"><totalsRowFormula>SUM(${name}[[#Totals],[Inflow]]-${name}[[#Totals],[Outflow]])</totalsRowFormula></tableColumn>`;
    }
    if (h === 'Date') {
      return `<tableColumn id="${id}" name="Date" totalsRowLabel="Total"/>`;
    }
    return `<tableColumn id="${id}" name="${h}"/>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${tableId}" name="${name}" displayName="${name}" ref="A1:J${lastRow}" totalsRowCount="1"><autoFilter ref="A1:J${lastDataRow}"/><tableColumns count="10">${cols}</tableColumns><tableStyleInfo name="TableStyleLight1" showFirstColumn="0" showLastColumn="0" showRowStripes="0" showColumnStripes="0"/></table>`;
}

function sheetRelsXml(tableFileIndex) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table${tableFileIndex}.xml"/></Relationships>`;
}

/**
 * Build a structurally-valid Banking transactions workbook for golden tests.
 *
 * The output mirrors `Banking transactions - Gulliver Lux YYYY.xlsx` enough to exercise
 * the write paths in server/services/banking.js: each monthly sheet has the documented
 * column layout, an opening balance row at row 2, a totals row with the structured-
 * reference Balance formula, and a backing Excel Table with real `xl/tables/tableN.xml`.
 *
 * @param {string} filePath - absolute path to write the .xlsx to
 * @param {object} opts
 * @param {number} opts.openingBalance - F2 value on GEN
 * @param {Record<string, Array<{date:string,type?:string,transaction:string,notes?:string,iban?:string,inflow?:number,outflow?:number,cashFlow?:string,comments?:string}>>} opts.transactions - per-month tx list
 */
export async function buildBankingFixture(filePath, opts = {}) {
  const openingBalance = opts.openingBalance ?? 100000;
  const txByMonth = opts.transactions || {};

  // --- Step 1: cell-level content via xlsx-populate ---
  const wb = await XlsxPopulate.fromBlankAsync();

  for (let i = 0; i < MONTHS.length; i++) {
    const m = MONTHS[i];
    const ws = i === 0 ? wb.sheet(0).name(m) : wb.addSheet(m);
    // Header row
    TX_HEADERS.forEach((h, c) => ws.cell(1, c + 1).value(h));

    // Row 2: opening balance carry row
    ws.cell('A2').value(`01/${String(i + 1).padStart(2, '0')}/2026`);
    ws.cell('C2').value('Balance');
    if (i === 0) {
      ws.cell('F2').value(openingBalance);
    } else {
      ws.cell('F2').formula(`${tableDisplayName(i - 1)}[[#Totals],[Balance]]`);
    }
    ws.cell('H2').formula('SUM(H1,F2,-G2)');

    // Data rows
    const txs = txByMonth[m] || [];
    txs.forEach((tx, idx) => {
      const r = 3 + idx;
      if (tx.date) {
        const [y, mm, d] = tx.date.split('-');
        ws.cell(`A${r}`).value(`${d}/${mm}/${y}`);
      }
      if (tx.type) ws.cell(`B${r}`).value(tx.type);
      if (tx.transaction) ws.cell(`C${r}`).value(tx.transaction);
      if (tx.notes) ws.cell(`D${r}`).value(tx.notes);
      if (tx.iban) ws.cell(`E${r}`).value(tx.iban);
      if (tx.inflow) ws.cell(`F${r}`).value(Number(tx.inflow));
      if (tx.outflow) ws.cell(`G${r}`).value(Number(tx.outflow));
      ws.cell(`H${r}`).formula(`SUM(H${r - 1},F${r},-G${r})`);
      if (tx.cashFlow) ws.cell(`I${r}`).value(tx.cashFlow);
      if (tx.comments) ws.cell(`J${r}`).value(tx.comments);
    });

    // Totals row
    const lastDataRow = Math.max(2, 2 + txs.length);
    const totalsRow = lastDataRow + 1;
    ws.cell(`A${totalsRow}`).value('Total');
    ws.cell(`F${totalsRow}`).formula(`SUM(F2:F${lastDataRow})`);
    ws.cell(`G${totalsRow}`).formula(`SUM(G2:G${lastDataRow})`);
    ws.cell(`H${totalsRow}`).formula(
      `SUM(${tableDisplayName(i)}[[#Totals],[Inflow]]-${tableDisplayName(i)}[[#Totals],[Outflow]])`,
    );
  }

  // Elements sheet — plain layout; no SUMIF formulas (extendElementsRangesForMonth is a no-op then)
  const elements = wb.addSheet('Elements');
  elements.cell('A3').value('Elements');
  elements.cell('B3').value('Category');
  elements.cell('C3').value('Cost');
  elements.cell('D3').value('Revenue');

  // values sheet — CF category list referenced by data validation
  const values = wb.addSheet('values');
  values.cell('A1').value('Cash Flow Categories');

  await wb.toFileAsync(filePath);

  // --- Step 2: inject table XML, sheet rels, tableParts, content-type overrides ---
  const buf = await readFile(filePath);
  const zip = await JSZip.loadAsync(buf);

  for (let i = 0; i < MONTHS.length; i++) {
    const txs = txByMonth[MONTHS[i]] || [];
    const lastDataRow = Math.max(2, 2 + txs.length);
    const tableFileIndex = i * 2 + 1; // mainTablePath convention
    const tableId = 100 + i;

    zip.file(`xl/tables/table${tableFileIndex}.xml`, tableXmlForMonth(i, lastDataRow, tableId));
    zip.file(`xl/worksheets/_rels/sheet${i + 1}.xml.rels`, sheetRelsXml(tableFileIndex));

    const sheetPath = `xl/worksheets/sheet${i + 1}.xml`;
    let sheetXml = await zip.file(sheetPath).async('string');
    if (!sheetXml.includes('<tableParts')) {
      sheetXml = sheetXml.replace(
        '</worksheet>',
        '<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>',
      );
    }
    zip.file(sheetPath, sheetXml);
  }

  // Content types overrides
  const ctPath = '[Content_Types].xml';
  let ct = await zip.file(ctPath).async('string');
  const tableCT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml';
  for (let i = 0; i < MONTHS.length; i++) {
    const tableFileIndex = i * 2 + 1;
    const partName = `/xl/tables/table${tableFileIndex}.xml`;
    if (!ct.includes(`PartName="${partName}"`)) {
      ct = ct.replace('</Types>', `<Override PartName="${partName}" ContentType="${tableCT}"/></Types>`);
    }
  }
  zip.file(ctPath, ct);

  const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await writeFile(filePath, out);
}

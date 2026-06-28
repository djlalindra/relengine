import * as XLSX from "xlsx";

export type SheetData = {
  name: string; // sheet tab name, max 31 chars per Excel limit
  rows: (string | number)[][]; // first row is treated as the header
};

/**
 * Builds and downloads a real multi-tab XLSX workbook -- one worksheet
 * per data category (page-by-page, missing entities, missing keywords,
 * uncovered passages, optimization table), rather than cramming
 * differently-shaped data into one flat CSV.
 */
export function downloadXlsx(filename: string, sheets: SheetData[]) {
  const workbook = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const worksheet = XLSX.utils.aoa_to_sheet(sheet.rows);
    // Excel sheet names: max 31 chars, no : \ / ? * [ ]
    const safeName = sheet.name.replace(/[:\\/?*[\]]/g, "").slice(0, 31);
    XLSX.utils.book_append_sheet(workbook, worksheet, safeName || "Sheet");
  }

  XLSX.writeFile(workbook, filename);
}

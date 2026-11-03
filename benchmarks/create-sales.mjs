import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../skills/doktimoi/package.json', import.meta.url));
const XLSX = require('xlsx');
const workbook = XLSX.utils.book_new();
const sheet = XLSX.utils.aoa_to_sheet([
  ['Product / tuote', 'Annual price EUR excl. VAT', 'First-year discount', 'First-year price EUR'],
  ['Enterprise', 24000, 0.15, 20400],
  ['Onboarding / käyttöönotto', 3000, 0, 3000],
]);
sheet.D2.f = 'B2*(1-C2)';
sheet.D3.f = 'B3*(1-C3)';
sheet.B2.z = sheet.D2.z = '#,##0.00 "EUR"';
sheet.C2.z = '0%';
XLSX.utils.book_append_sheet(workbook, sheet, 'Pricing');
const notes = XLSX.utils.aoa_to_sheet([
  ['Currency', 'EUR'], ['VAT', 'Excluded'], ['Discount condition', 'Sign before 2026-12-31'],
]);
XLSX.utils.book_append_sheet(workbook, notes, 'Conditions');
XLSX.writeFile(workbook, fileURLToPath(new URL('../examples/sales/pricing.xlsx', import.meta.url)));

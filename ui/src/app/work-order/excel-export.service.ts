import { Injectable } from '@angular/core';
import * as XLSX from 'xlsx';
import { WorkOrderItem } from './work-order.model';

@Injectable({ providedIn: 'root' })
export class ExcelExportService {

  generateEstimateSheet(
    nameOfWork: string,
    savedItems: WorkOrderItem[],
    gstRate: number,
    gstAmount: number,
    grandTotal: number,
    lsAmount: number = 0
  ): void {
    const wb = XLSX.utils.book_new();

    const materialItems = savedItems.filter(i => i.isMaterial === 'Yes');
    const nonMaterialItems = savedItems.filter(i => i.isMaterial === 'No');
    const materialTotal = materialItems.reduce((s, i) => s + i.amount, 0);
    const nonMaterialTotal = nonMaterialItems.reduce((s, i) => s + i.amount, 0);
    const abstractGrand = grandTotal || (materialTotal + nonMaterialTotal + gstAmount + lsAmount);

    this.addItemSheet(wb, 'Material Sheet', materialItems, materialTotal);
    this.addItemSheet(wb, 'Non-Material Sheet', nonMaterialItems, nonMaterialTotal);
    this.addAbstractSheet(wb, nameOfWork, materialTotal, nonMaterialTotal, gstRate, gstAmount, lsAmount, abstractGrand);

    const safeName = (nameOfWork || 'Work Order').trim();
    XLSX.writeFile(wb, `Estimate Sheet- ${safeName}.xlsx`);
  }

  private addItemSheet(
    wb: XLSX.WorkBook,
    sheetName: string,
    items: WorkOrderItem[],
    total: number
  ): void {
    const ws = XLSX.utils.aoa_to_sheet([]);

    const headers = [
      'Sl.No', 'Item Description', 'Numbers',
      'Length', 'Breadth', 'Depth',
      'Quantity', 'Unit', 'Rate (Rs.)', 'Amount (Rs.)'
    ];

    XLSX.utils.sheet_add_aoa(ws, [headers], { origin: 'A1' });

    const rows = items.map((item, idx) => [
      idx + 1,
      item.description,
      item.numbers,
      item.length || '',
      item.breadth || '',
      item.depth || '',
      item.quantity,
      item.unit,
      item.rate,
      item.amount
    ]);

    if (rows.length > 0) {
      XLSX.utils.sheet_add_aoa(ws, rows, { origin: 'A2' });
    } else {
      XLSX.utils.sheet_add_aoa(ws, [['No items']], { origin: 'A2' });
    }

    const totalRowIdx = rows.length + 2;
    XLSX.utils.sheet_add_aoa(ws, [
      ['', '', '', '', '', '', '', '', 'Total Amount (Rs.)', total]
    ], { origin: `A${totalRowIdx}` });

    ws['!cols'] = [
      { wch: 7 },
      { wch: 45 },
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
      { wch: 10 },
      { wch: 12 },
      { wch: 8 },
      { wch: 14 },
      { wch: 14 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  private addAbstractSheet(
    wb: XLSX.WorkBook,
    nameOfWork: string,
    materialTotal: number,
    nonMaterialTotal: number,
    gstRate: number,
    gstAmount: number,
    lsAmount: number,
    abstractGrand: number
  ): void {
    const partOneTotal = materialTotal + nonMaterialTotal;
    const amountWords = this.amountInWords(Math.round(abstractGrand));

    const ws = XLSX.utils.aoa_to_sheet([
      ['', 'GENERAL ABSTRACT', '', ''],
      [`Name of Work: ${nameOfWork || ''}`, '', '', ''],
      ['Sl.No', 'Description', '', 'Amount Rs.'],
      ['', 'Part-I - Working Items', '', ''],
      [1, 'Cost of Material', '', materialTotal],
      [2, 'Cost of Civil work', '', nonMaterialTotal],
      ['', 'Cost of Estimate : Part-I', '', partOneTotal],
      ['', 'Part-II - Reimbursible Items', '', ''],
      [3, `GST @ ${gstRate}%`, 'Rs.', gstAmount],
      ['', '', '', ''],
      ['', 'Part-III: LS provisions', '', ''],
      [4, 'LS unforeseen items and rounding off', 'Rs.', lsAmount],
      ['', '', '', ''],
      [5, 'Grand Total (Part I + II + III)', 'Rs.', abstractGrand],
      ['', `(Rupees ${amountWords} Only)`, '', '']
    ]);

    ws['!merges'] = [
      { s: { r: 0, c: 1 }, e: { r: 0, c: 3 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 3 } },
      { s: { r: 2, c: 1 }, e: { r: 2, c: 2 } },
      { s: { r: 3, c: 1 }, e: { r: 3, c: 2 } },
      { s: { r: 4, c: 1 }, e: { r: 4, c: 2 } },
      { s: { r: 5, c: 1 }, e: { r: 5, c: 2 } },
      { s: { r: 6, c: 1 }, e: { r: 6, c: 2 } },
      { s: { r: 7, c: 1 }, e: { r: 7, c: 2 } },
      { s: { r: 9, c: 1 }, e: { r: 9, c: 2 } },
      { s: { r: 10, c: 1 }, e: { r: 10, c: 2 } },
      { s: { r: 12, c: 1 }, e: { r: 12, c: 2 } },
      { s: { r: 14, c: 1 }, e: { r: 14, c: 3 } }
    ];

    ws['!cols'] = [
      { wch: 8 },
      { wch: 62 },
      { wch: 8 },
      { wch: 18 },
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Abstract');
  }

  private amountInWords(amount: number): string {
    if (!Number.isFinite(amount) || amount <= 0) return 'Zero';

    const ones = [
      '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
      'Seventeen', 'Eighteen', 'Nineteen'
    ];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    const twoDigits = (n: number): string => {
      if (n < 20) return ones[n];
      return `${tens[Math.floor(n / 10)]}${n % 10 ? ' ' + ones[n % 10] : ''}`;
    };

    const threeDigits = (n: number): string => {
      const hundred = Math.floor(n / 100);
      const rest = n % 100;
      return `${hundred ? ones[hundred] + ' Hundred' : ''}${hundred && rest ? ' ' : ''}${rest ? twoDigits(rest) : ''}`.trim();
    };

    const crore = Math.floor(amount / 10000000);
    amount %= 10000000;
    const lakh = Math.floor(amount / 100000);
    amount %= 100000;
    const thousand = Math.floor(amount / 1000);
    amount %= 1000;

    return [
      crore ? `${threeDigits(crore)} Crore` : '',
      lakh ? `${threeDigits(lakh)} Lakh` : '',
      thousand ? `${threeDigits(thousand)} Thousand` : '',
      amount ? threeDigits(amount) : ''
    ].filter(Boolean).join(' ');
  }
}
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { AbstractStateService } from '../work-order/abstract-state.service';
import { AuthService } from '../login/auth.service';
import { ExcelExportService } from '../work-order/excel-export.service';

@Component({
  selector: 'app-abstract',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  templateUrl: './abstract.component.html',
  styleUrls: ['./abstract.component.css']
})
export class AbstractComponent implements OnInit {

  private apiBase = 'http://localhost:3000/api';

  nameOfWork: string = '';
  division:   string = '';
  circle:     string = '';
  ward:       string = '';
  savedItems: any[]  = [];
  gstRate:    number = 0;
  gstAmount:  number = 0;

  materialItems:   any[]  = [];
  civilWorksItems: any[]  = [];
  materialTotal:   number = 0;
  civilWorksTotal: number = 0;
  lsAmount:        number = 0;
  grandTotal:      number = 0;

  part2CustomRows: any[] = [];
  part3CustomRows: any[] = [];

  // Workflow flags
  workId:          string  = '';
  viewOnly:        boolean = false;
  canEditAbstract: boolean = true;
  fromPage:        string  = '';

  // Save state
  editedBy:    string  = '';
  isSaving:    boolean = false;
  saveSuccess: boolean = false;
  saveError:   string  = '';
  generatedWorkId: string = '';
  isSubmitting: boolean = false;
  submitSuccess: string = '';
  submitError: string = '';

  constructor(
    private stateService: AbstractStateService,
    private http: HttpClient,
    private router: Router,
    private auth: AuthService,
    private excelExport: ExcelExportService
  ) {}

  get userName()        { return this.auth.getSession()?.name        || ''; }
  get userDesignation() { return this.auth.getSession()?.designation || ''; }
  get isDirector()      { return this.userDesignation === 'Director'; }

  onLogout(): void { this.auth.logout(); this.router.navigate(['/login']); }

  private get draftKey() { return `abstract_draft_${this.workId || this.nameOfWork}`; }

  ngOnInit(): void {
    const state = this.stateService.getState();
    if (!state) { this.router.navigate(['/']); return; }

    this.nameOfWork = state.nameOfWork;
    this.division   = state.division;
    this.circle     = state.circle;
    this.ward       = state.ward;
    this.savedItems = state.savedItems;
    this.gstRate    = state.gstRate;
    this.gstAmount  = state.gstAmount;
    this.workId          = state.workId   || '';
    this.viewOnly        = state.viewOnly  || false;
    this.canEditAbstract = state.canEdit  !== false;
    this.fromPage        = state.fromPage || '';

    this.materialItems   = this.savedItems.filter((i: any) => i.isMaterial === 'Yes');
    this.civilWorksItems = this.savedItems.filter((i: any) => i.isMaterial === 'No');
    this.materialTotal   = parseFloat(this.materialItems.reduce((s: number, i: any) => s + i.amount, 0).toFixed(2));
    this.civilWorksTotal = parseFloat(this.civilWorksItems.reduce((s: number, i: any) => s + i.amount, 0).toFixed(2));

    // Restore LS from localStorage if available
    this.restoreDraft();
    this.recalcGrandTotal();

    // If work already has an abstract in DB, load the LS from it
    if (this.workId) { this.loadExistingAbstract(); }
  }

  // ── Load existing abstract from DB (restores LS and custom rows) ─────────────
  loadExistingAbstract(): void {
    this.http.get<any>(`${this.apiBase}/works/${this.workId}/abstract`).subscribe({
      next: (data) => {
        if (data && data.ls_amount != null) {
          this.lsAmount = Number(data.ls_amount) || 0;
        }
        if (data && data.custom_rows) {
          const customRows = typeof data.custom_rows === 'string' ? JSON.parse(data.custom_rows) : data.custom_rows;
          this.part2CustomRows = customRows?.part2 || [];
          this.part3CustomRows = customRows?.part3 || [];
        }
        this.recalcGrandTotal();
      },
      error: () => {} // no abstract yet — that's fine
    });
  }

  // ── localStorage draft for LS ─────────────────────────────────
  saveDraft(): void {
    try { localStorage.setItem(this.draftKey, JSON.stringify({
      lsAmount: this.lsAmount,
      part2CustomRows: this.part2CustomRows,
      part3CustomRows: this.part3CustomRows
    })); } catch(e) {}
  }

  restoreDraft(): void {
    try {
      const raw = localStorage.getItem(this.draftKey);
      if (raw) {
        const d = JSON.parse(raw);
        this.lsAmount = d.lsAmount || 0;
        this.part2CustomRows = d.part2CustomRows || [];
        this.part3CustomRows = d.part3CustomRows || [];
      }
    } catch(e) {}
  }

  clearDraft(): void {
    try { localStorage.removeItem(this.draftKey); } catch(e) {}
  }

  onLsChange(): void {
    this.recalcGrandTotal();
    this.saveDraft();       // auto-save LS to localStorage instantly
    this.saveAbstractToDB(); // also persist to DB silently
  }

  addPart2Row(): void {
    this.part2CustomRows.push({ description: '', amount: 0 });
    this.recalcGrandTotal();
    this.saveDraft();
  }

  addPart3Row(): void {
    this.part3CustomRows.push({ description: '', amount: 0 });
    this.recalcGrandTotal();
    this.saveDraft();
  }

  deletePart2Row(index: number): void {
    this.part2CustomRows.splice(index, 1);
    this.recalcGrandTotal();
    this.saveDraft();
  }

  deletePart3Row(index: number): void {
    this.part3CustomRows.splice(index, 1);
    this.recalcGrandTotal();
    this.saveDraft();
  }

  onCustomRowAmountChange(): void {
    this.recalcGrandTotal();
    this.saveDraft();
  }

  recalcGrandTotal(): void {
    const part2Total = this.part2CustomRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const part3Total = this.part3CustomRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    this.grandTotal = parseFloat(
      (this.materialTotal + this.civilWorksTotal + this.gstAmount + (this.lsAmount || 0) + part2Total + part3Total).toFixed(2)
    );
  }

  // ── Save abstract to DB silently (called on LS change & on submit) ──
  saveAbstractToDB(onDone?: (success: boolean, error?: any) => void): void {
    if (!this.workId && !this.nameOfWork) return;

    const payload = {
      workId:          this.workId,
      nameOfWork:      this.nameOfWork,
      materialTotal:   this.materialTotal,
      civilWorksTotal: this.civilWorksTotal,
      gstRate:         this.gstRate,
      gstAmount:       this.gstAmount,
      lsAmount:        this.lsAmount || 0,
      grandTotal:      this.grandTotal,
      editedBy:        this.userName,
      customRows: {
        part2: this.part2CustomRows,
        part3: this.part3CustomRows
      }
    };

    // Use upsert endpoint — insert or update if work_id already exists
    this.http.post<any>(`${this.apiBase}/save-abstract`, payload).subscribe({
      next: () => { if (onDone) onDone(true); },
      error: (err) => { if (onDone) onDone(false, err); }
    });
  }

  // ── Explicit Save button ──────────────────────────────────────
  onSave(): void {
    if (this.isSaving) return;
    this.isSaving    = true;
    this.saveSuccess = false;
    this.saveError   = '';
    this.recalcGrandTotal();
    this.saveAbstractToDB((success, err) => {
      this.isSaving = false;
      if (success) {
        this.saveSuccess = true;
        this.saveDraft();
        // Auto-dismiss the success message after 3 seconds
        setTimeout(() => { this.saveSuccess = false; }, 3000);
      } else {
        this.saveError = err?.error?.detail || err?.error?.error || 'Save failed. Please try again.';
        setTimeout(() => { this.saveError = ''; }, 4000);
      }
    });
  }

  generateExcel(): void {
    this.recalcGrandTotal();
    this.saveAbstractToDB(() => {
      this.excelExport.generateEstimateSheet(
        this.nameOfWork,
        this.savedItems,
        this.gstRate,
        this.gstAmount,
        this.grandTotal,
        this.lsAmount || 0
      );
    });
  }

  submitAbstract(): void {
    this.submitSuccess = '';
    this.submitError = '';

    if (!this.workId) {
      this.submitError = 'Work ID is missing. Please go back and generate the abstract again.';
      return;
    }

    this.isSubmitting = true;
    this.recalcGrandTotal();

    this.saveAbstractToDB((saved, saveErr) => {
      if (!saved) {
        this.isSubmitting = false;
        this.submitError = saveErr?.error?.detail || 'Could not save abstract before submitting.';
        return;
      }

      this.http.post<any>(`${this.apiBase}/works/${this.workId}/submit`, {
        submittedBy: this.userName,
        designation: this.userDesignation,
        remarks: ''
      }).subscribe({
        next: () => {
          this.isSubmitting = false;
          this.submitSuccess = 'Submitted successfully.';
          this.viewOnly = true;
          this.canEditAbstract = false;
          this.clearDraft();
        },
        error: (err) => {
          this.isSubmitting = false;
          this.submitError = err?.error?.detail || err?.error?.error || 'Submit failed.';
        }
      });
    });
  }

  goBack(): void {
    if (this.fromPage === 'reports') { this.router.navigate(['/reports']); return; }
    this.router.navigate(['/home']);
  }
  goBackToEstimate(): void { this.router.navigate(['/prepare-estimate']); }
}
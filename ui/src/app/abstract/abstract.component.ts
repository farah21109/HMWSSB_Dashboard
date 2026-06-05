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

  private apiBase = 'http://localhost:3001/api';

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

  // ── Load existing abstract from DB (restores LS) ─────────────
  loadExistingAbstract(): void {
    this.http.get<any>(`${this.apiBase}/works/${this.workId}/abstract`).subscribe({
      next: (data) => {
        if (data && data.ls_amount != null) {
          this.lsAmount = Number(data.ls_amount) || 0;
          this.recalcGrandTotal();
        }
      },
      error: () => {} // no abstract yet — that's fine
    });
  }

  // ── localStorage draft for LS ─────────────────────────────────
  saveDraft(): void {
    try { localStorage.setItem(this.draftKey, JSON.stringify({ lsAmount: this.lsAmount })); } catch(e) {}
  }

  restoreDraft(): void {
    try {
      const raw = localStorage.getItem(this.draftKey);
      if (raw) { const d = JSON.parse(raw); this.lsAmount = d.lsAmount || 0; }
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

  recalcGrandTotal(): void {
    this.grandTotal = parseFloat(
      (this.materialTotal + this.civilWorksTotal + this.gstAmount + (this.lsAmount || 0)).toFixed(2)
    );
  }

  // ── Save abstract to DB silently (called on LS change & on submit) ──
  saveAbstractToDB(onDone?: () => void): void {
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
      editedBy:        this.userName
    };

    // Use upsert endpoint — insert or update if work_id already exists
    this.http.post<any>(`${this.apiBase}/save-abstract`, payload).subscribe({
      next: () => { if (onDone) onDone(); },
      error: () => { if (onDone) onDone(); }
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

  goBack(): void { this.router.navigate(['/home']); }
  goBackToEstimate(): void { this.router.navigate(['/prepare-estimate']); }
}
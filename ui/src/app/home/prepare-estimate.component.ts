import { Component, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService, User } from '../login/auth.service';
import { AbstractStateService } from '../work-order/abstract-state.service';
import { WorkItemService, WorkItemSuggestion } from '../work-order/work-item.service';
import { ALL_CIRCLES, ALL_DIVISIONS, ALL_WARDS, CIRCLE_DIVISIONS, DIVISION_WARDS } from './location-data';

// Hierarchy: Manager → DGM → GM → CGM → Director
const NEXT_STAGE: { [key: string]: string } = {
  'Manager': 'DGM',
  'DGM':     'GM',
  'GM':      'CGM',
  'CGM':     'Director',
  'Director': ''
};

@Component({
  selector: 'app-prepare-estimate',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  templateUrl: './prepare-estimate.component.html',
  styleUrls: ['./prepare-estimate.component.css']
})
export class PrepareEstimateComponent implements OnInit {

  private apiBase = 'http://localhost:3000/api';

  // ── Step 1: Work ID check ─────────────────────────────────────
  workIdInput: string  = '';
  isChecking:  boolean = false;
  checkError:  string  = '';
  workChecked: boolean = false;

  // Result from check
  workExists:    boolean = false;
  accessLevel:   string  = '';   // 'view' | 'edit' | 'none'
  existingWorkId: string = '';
  currentStage:   string = '';
  nextStage:      string = '';

  // ── Form fields ───────────────────────────────────────────────
  nameOfWork:       string = '';
  selectedDivision: string = '';
  selectedCircle:   string = '';
  selectedWard:     string = '';

  // Location dropdowns — filtered to user's assigned areas
  circles:   string[] = [];
  divisions: string[] = [];
  wards:     string[] = [];

  // Parse comma-separated field from user session into array
  private splitField(val: string | null | undefined): string[] {
    if (!val) return [];
    return val.split(',').map(v => v.trim()).filter(v => v.length > 0);
  }

  private circlesForDivision(division: string): string[] {
    if (!division) return ALL_CIRCLES;
    return ALL_CIRCLES.filter(circle => (CIRCLE_DIVISIONS[circle] || []).includes(division));
  }

  // Called once on init — set up dropdowns based on user's assignments
  initLocationDropdowns(): void {
    const userDivisions = this.splitField(this.user?.division);
    const userWards     = this.splitField(this.user?.ward);

    // Division is selected first; circles are then filtered under that division.
    this.divisions = userDivisions.length > 0 ? userDivisions : ALL_DIVISIONS;
    this.circles   = [];
    this.wards     = userWards.length > 0 ? userWards : ALL_WARDS;

    // Auto-select if only one option
    if (this.divisions.length === 1) this.selectedDivision = this.divisions[0];
    if (this.selectedDivision) this.setCirclesAndWardsForDivision();
    if (this.circles.length === 1) this.selectedCircle = this.circles[0];
    if (this.wards.length === 1) this.selectedWard = this.wards[0];
  }

  onCircleChange(value: string): void {
    this.selectedCircle   = value;
    this.saveDraft();
  }

  onDivisionChange(value: string): void {
    this.selectedDivision = value;
    this.setCirclesAndWardsForDivision();
    this.saveDraft();
  }

  private setCirclesAndWardsForDivision(): void {
    const userCircles = this.splitField(this.user?.circle);
    const userWards       = this.splitField(this.user?.ward);
    const divCircles      = this.circlesForDivision(this.selectedDivision);
    this.circles          = userCircles.length > 0
      ? divCircles.filter(c => userCircles.includes(c))
      : divCircles;
    if (this.circles.length === 0) this.circles = divCircles;
    this.selectedCircle   = this.circles.length === 1 ? this.circles[0] : '';

    const divWards        = DIVISION_WARDS[this.selectedDivision] || ALL_WARDS;
    this.wards            = userWards.length > 0
      ? divWards.filter(w => userWards.includes(w))
      : divWards;
    if (this.wards.length === 0) this.wards = divWards;
    this.selectedWard     = this.wards.length === 1 ? this.wards[0] : '';
  }

  onWardChange(): void { this.saveDraft(); }

  gstOptions:      number[] = [0, 5, 18];
  selectedGstRate: number   = 0;

  savedItems:  any[] = [];
  currentItem: any   = this.createEmptyItem(1);
  editingIndex: number = -1;
  totals = { totalAmount: 0, gst: 0, grandTotal: 0 };

  // ── Autocomplete ──────────────────────────────────────────────
  suggestions:  any[]   = [];
  showDropdown: boolean  = false;
  isLoadingSuggestions: boolean = false;
  private searchTimer: any = null;

  // ── Submission info (from DB) ────────────────────────────────
  lastSubmittedAt: string = '';
  lastSubmittedBy: string = '';
  lastFromStage:   string = '';
  lastToStage:     string = '';

  // ── Submit dialog ─────────────────────────────────────────────
  showSubmitDialog: boolean = false;
  submitRemarks:    string  = '';
  isSubmitting:     boolean = false;
  submitSuccess:    string  = '';
  submitError:      string  = '';
  submitDateTime:   string  = '';  // shown after submit

  constructor(
    private auth:            AuthService,
    private http:            HttpClient,
    private router:          Router,
    private stateService:    AbstractStateService,
    private workItemService: WorkItemService
  ) {}

  get user(): User | null { return this.auth.getSession(); }
  get userName()        { return this.user?.name        || ''; }
  get userDesignation() { return this.user?.designation || ''; }
  get myNextStage()     { return NEXT_STAGE[this.userDesignation] || ''; }
  get userWard()        { return this.user?.ward        || ''; }

  // Is this a new work (not found in DB)?
  get isNewWork():  boolean { return this.workChecked && !this.workExists; }
  // Existing work, view only
  get isViewOnly(): boolean { return this.workExists && this.accessLevel === 'view'; }
  // Existing work, editable at this stage
  get isEditable(): boolean { return this.workExists && this.accessLevel === 'edit'; }

  private DRAFT_KEY = 'prepare_estimate_draft';

  ngOnInit(): void {
    this.initLocationDropdowns();  // set up dropdowns from user's assigned areas
    this.restoreDraft();
    const navWorkId = history.state?.workId;
    if (navWorkId) {
      this.workIdInput = navWorkId;
      setTimeout(() => this.onCheckWorkId(), 0);
    }
  }

  // ── Auto-save draft to localStorage ──────────────────────────
  saveDraft(): void {
    if (!this.nameOfWork.trim() && this.savedItems.length === 0) return;
    const draft = {
      nameOfWork:       this.nameOfWork,
      selectedDivision: this.selectedDivision,
      selectedCircle:   this.selectedCircle,
      selectedWard:     this.selectedWard,
      selectedGstRate:  this.selectedGstRate,
      savedItems:       this.savedItems,
      existingWorkId:   this.existingWorkId,
      workChecked:      this.workChecked,
      workExists:       this.workExists,
      accessLevel:      this.accessLevel,
      currentStage:     this.currentStage,
      nextStage:        this.nextStage,
      lastSubmittedAt:  this.lastSubmittedAt,
      lastSubmittedBy:  this.lastSubmittedBy,
      lastFromStage:    this.lastFromStage,
      lastToStage:      this.lastToStage,
      savedAt:          new Date().toISOString()
    };
    try { localStorage.setItem(this.DRAFT_KEY, JSON.stringify(draft)); } catch (e) {}
  }

  restoreDraft(): void {
    try {
      const raw = localStorage.getItem(this.DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      this.nameOfWork       = draft.nameOfWork       || '';
      this.selectedDivision = draft.selectedDivision || '';
      this.selectedCircle   = draft.selectedCircle   || '';
      this.selectedWard     = draft.selectedWard     || '';
      // Restore cascaded lists
      if (this.selectedDivision) {
        const restoredCircle = this.selectedCircle;
        const restoredWard = this.selectedWard;
        this.setCirclesAndWardsForDivision();
        if (restoredCircle && this.circles.includes(restoredCircle)) this.selectedCircle = restoredCircle;
        if (restoredWard && this.wards.includes(restoredWard)) this.selectedWard = restoredWard;
      }
      this.selectedGstRate  = draft.selectedGstRate  || 0;
      this.savedItems       = draft.savedItems       || [];
      this.existingWorkId   = draft.existingWorkId   || '';
      this.workChecked      = draft.workChecked      || false;
      this.workExists       = draft.workExists       || false;
      this.accessLevel      = draft.accessLevel      || '';
      this.currentStage     = draft.currentStage     || '';
      this.nextStage        = draft.nextStage        || '';
      this.lastSubmittedAt  = draft.lastSubmittedAt  || '';
      this.lastSubmittedBy  = draft.lastSubmittedBy  || '';
      this.lastFromStage    = draft.lastFromStage    || '';
      this.lastToStage      = draft.lastToStage      || '';
      this.workIdInput      = this.nameOfWork;
      this.currentItem      = this.createEmptyItem(this.savedItems.length + 1);
      this.refreshTotals();
      if (draft.savedAt) {
        const d = new Date(draft.savedAt);
        this.draftRestoredMsg = 'Draft restored from ' + d.toLocaleDateString('en-IN') + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      }
    } catch (e) {}
  }

  clearDraft(): void {
    try { localStorage.removeItem(this.DRAFT_KEY); } catch (e) {}
    this.draftRestoredMsg = '';
  }

  draftRestoredMsg: string = '';

  // ── Check Work ID ─────────────────────────────────────────────
  onCheckWorkId(): void {
    if (!this.workIdInput.trim()) {
      this.checkError = 'Please enter a Work ID or Name.';
      return;
    }
    this.isChecking  = true;
    this.checkError  = '';
    this.workChecked = false;
    this.workExists  = false;
    this.savedItems  = [];

    this.http.get<any>(
      `${this.apiBase}/works/check?workId=${encodeURIComponent(this.workIdInput.trim())}&designation=${encodeURIComponent(this.userDesignation)}`
    ).subscribe({
      next: (res) => {
        this.isChecking  = false;
        this.workChecked = true;

        if (res.exists) {
          this.workExists     = true;
          this.accessLevel    = res.access;
          this.existingWorkId = res.work_id;
          this.currentStage   = res.current_stage;
          this.nextStage      = res.next_stage || '';
          this.nameOfWork     = res.name_of_work;
          this.selectedDivision = res.division || '';
          this.selectedCircle   = res.circle   || '';
          this.selectedWard     = res.ward      || '';
          // Restore cascaded lists from loaded data
          if (this.selectedDivision) {
            const loadedCircle = this.selectedCircle;
            const loadedWard = this.selectedWard;
            this.setCirclesAndWardsForDivision();
            if (loadedCircle && this.circles.includes(loadedCircle)) this.selectedCircle = loadedCircle;
            if (loadedWard && this.wards.includes(loadedWard)) this.selectedWard = loadedWard;
          }
          // Store last submission info
          if (res.last_submitted_at) {
            const d = new Date(res.last_submitted_at);
            this.lastSubmittedAt = d.toLocaleDateString('en-IN') + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
            this.lastSubmittedBy = res.last_submitted_by || '';
            this.lastFromStage   = res.last_from_stage   || '';
            this.lastToStage     = res.last_to_stage     || '';
          }

          // Load items
          this.http.get<any[]>(`${this.apiBase}/works/${res.work_id}/items`).subscribe({
            next: (items) => {
              this.savedItems = items.map((i: any, idx: number) => ({
                sNo:         idx + 1,
                description: i.description,
                numbers:     i.numbers,
                length:      i.length,
                breadth:     i.breadth,
                depth:       i.depth,
                quantity:    i.quantity,
                unit:        i.unit,
                rate:        i.rate,
                amount:      Number(i.amount) || 0,
                isMaterial:  i.is_material ? 'Yes' : 'No',
                item_id:     i.item_id
              }));
              this.currentItem = this.createEmptyItem(this.savedItems.length + 1);
              this.refreshTotals();
            }
          });
        } else {
          // New work
          this.workExists  = false;
          this.accessLevel = 'edit';
          this.nameOfWork  = this.workIdInput.trim();
        }
      },
      error: () => {
        this.isChecking  = false;
        this.workChecked = true;
        this.workExists  = false;
        this.accessLevel = 'edit';
        this.nameOfWork  = this.workIdInput.trim();
      }
    });
  }

  // ── Autocomplete ──────────────────────────────────────────────
  onDescriptionInput(): void {
    // Use raw value (with spaces) so multi-word search works
    const raw = (this.currentItem.description || '');
    const trimmed = raw.trim();
    if (this.searchTimer) clearTimeout(this.searchTimer);
    // Need at least 1 real character (ignore pure spaces)
    if (trimmed.length < 1) { this.suggestions = []; this.showDropdown = false; return; }
    // Keep dropdown open while typing — don't close it here
    this.searchTimer = setTimeout(() => {
      this.isLoadingSuggestions = true;
      // Send raw value so "dewatering t" sends both words to backend
      this.workItemService.searchItems(raw).subscribe({
        next: (results) => {
          this.suggestions  = results;
          this.showDropdown = results.length > 0;
          this.isLoadingSuggestions = false;
        },
        error: () => { this.suggestions = []; this.showDropdown = false; this.isLoadingSuggestions = false; }
      });
    }, 300);
  }

  // How many words has the user typed in the description box
  typedWordCount(): number {
    return (this.currentItem.description || '').trim().split(/\s+/).filter((w: string) => w.length > 0).length;
  }

  // Highlight each typed word in the suggestion text
  highlightMatch(text: string): string {
    if (!text) return '';
    const words = (this.currentItem.description || '').trim().split(/\s+/).filter(Boolean);
    // escape special regex chars
    if (words.length === 0) return text;
    let result = text;
    words.forEach((word: string) => {
      const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      result = result.replace(regex, '<mark>$1</mark>');
    });
    return result;
  }

  onSelectSuggestion(item: WorkItemSuggestion): void {
    this.currentItem.description = item.description;
    this.currentItem.rate        = Number(item.rate);
    this.currentItem.unit        = item.unit;
    this.currentItem.amount      = parseFloat((this.currentItem.quantity * this.currentItem.rate).toFixed(2));
    this.suggestions = []; this.showDropdown = false;
  }

  // Close dropdown only when clicking outside the suggestion area
  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    // Keep open if click is inside the description cell or suggestions list
    if (target.closest('.desc-cell') || target.closest('.suggestions-list')) return;
    this.showDropdown = false;
  }

  closeDropdown(): void { this.showDropdown = false; }

  // ── Row calculations ──────────────────────────────────────────
  onDimensionChange(): void {
    const item = this.currentItem;
    const filledDims = [item.length, item.breadth, item.depth].filter((v: number) => v > 0);
    let dp = filledDims.length === 0 ? 1 : filledDims.length === 1 ? filledDims[0] : filledDims.length === 2 ? filledDims[0] * filledDims[1] : filledDims[0] * filledDims[1] * filledDims[2];
    item.quantity = parseFloat(((item.numbers > 0 ? item.numbers : 1) * dp).toFixed(4));
    item.amount   = parseFloat((item.quantity * item.rate).toFixed(2));
  }
  onRateChange():     void { this.currentItem.amount = parseFloat((this.currentItem.quantity * this.currentItem.rate).toFixed(2)); }
  onQuantityChange(): void { this.currentItem.amount = parseFloat((this.currentItem.quantity * this.currentItem.rate).toFixed(2)); }

  onAdd(): void {
    if (this.editingIndex >= 0) {
      this.savedItems[this.editingIndex] = {
        ...this.currentItem,
        sNo: this.editingIndex + 1
      };
      this.editingIndex = -1;
    } else {
      this.savedItems.push({
        ...this.currentItem,
        sNo: this.savedItems.length + 1
      });
    }

    this.currentItem = this.createEmptyItem(this.savedItems.length + 1);
    this.refreshTotals();
    this.saveDraft();
  }

  onCancel(): void {
    this.editingIndex = -1;
    this.currentItem = this.createEmptyItem(this.savedItems.length + 1);
  }

  onDelete(i: number): void {
    this.savedItems.splice(i, 1);
    this.savedItems.forEach((item, idx) => item.sNo = idx + 1);

    if (this.editingIndex === i) {
      this.editingIndex = -1;
      this.currentItem = this.createEmptyItem(this.savedItems.length + 1);
    } else if (this.editingIndex > i) {
      this.editingIndex -= 1;
      this.currentItem.sNo = this.editingIndex + 1;
    } else {
      this.currentItem.sNo = this.editingIndex >= 0 ? this.editingIndex + 1 : this.savedItems.length + 1;
    }

    this.refreshTotals();
    this.saveDraft();
  }

  onEdit(i: number): void {
    this.editingIndex = i;
    this.currentItem = {
      ...this.savedItems[i],
      sNo: i + 1
    };
  }

  onGstRateChange():     void { this.totals.gst = parseFloat((this.totals.totalAmount * this.selectedGstRate / 100).toFixed(2)); this.totals.grandTotal = parseFloat((this.totals.totalAmount + this.totals.gst).toFixed(2)); this.saveDraft(); }
  onTotalAmountChange(): void { this.onGstRateChange(); }
  refreshTotals(): void { this.totals.totalAmount = parseFloat(this.savedItems.reduce((s, i) => s + i.amount, 0).toFixed(2)); this.onGstRateChange(); }
  getRowTotal(): number { return this.savedItems.reduce((s, i) => s + i.amount, 0); }

  // ── Submit dialog ─────────────────────────────────────────────
  openSubmitDialog(): void { this.submitRemarks = ''; this.submitSuccess = ''; this.submitError = ''; this.showSubmitDialog = true; }
  closeSubmitDialog(): void { this.showSubmitDialog = false; }

  onSubmit(): void {
    if (!this.nameOfWork.trim()) { this.submitError = 'Please enter a work name first.'; return; }
    if (this.savedItems.length === 0) { this.submitError = 'Please add at least one item first.'; return; }
    this.isSubmitting = true;
    this.submitError  = '';

    // If new work (no existingWorkId), save it first then submit
    const doSubmit = (workId: string) => {
      // Save abstract to DB before submitting (captures current totals + LS)
      // Read LS amount from localStorage (set by abstract page)
      let lsAmount = 0;
      try {
        const draftKey = `abstract_draft_${workId}`;
        const raw = localStorage.getItem(draftKey);
        if (raw) { lsAmount = JSON.parse(raw).lsAmount || 0; }
      } catch(e) {}

      const materialTotal   = this.savedItems.filter((i:any) => i.isMaterial === 'Yes').reduce((s:number,i:any) => s + Number(i.amount), 0);
      const civilWorksTotal = this.savedItems.filter((i:any) => i.isMaterial === 'No').reduce((s:number,i:any) => s + Number(i.amount), 0);
      const grandTotal      = parseFloat((materialTotal + civilWorksTotal + this.totals.gst + lsAmount).toFixed(2));

      const abstractPayload = {
        workId:          workId,
        nameOfWork:      this.nameOfWork,
        materialTotal:   materialTotal,
        civilWorksTotal: civilWorksTotal,
        gstRate:         this.selectedGstRate,
        gstAmount:       this.totals.gst,
        lsAmount:        lsAmount,
        grandTotal:      grandTotal,
        editedBy:        this.userName
      };
      this.http.post<any>(`${this.apiBase}/save-abstract`, abstractPayload).subscribe();

      this.http.post<any>(`${this.apiBase}/works/${workId}/submit`, {
        submittedBy:  this.userName,
        designation:  this.userDesignation,
        remarks:      this.submitRemarks
      }).subscribe({
        next: (res) => {
          this.isSubmitting  = false;
          this.submitSuccess = `Submitted to ${res.toStage} successfully!`;
          this.accessLevel   = 'view';
          this.workExists    = true;
          this.existingWorkId = workId;
          // Record submit date/time in HH:MM
          const now = new Date();
          const hhmm = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          const date  = now.toLocaleDateString('en-IN');
          this.submitDateTime  = date + ' at ' + hhmm;
          this.lastSubmittedAt = this.submitDateTime;
          this.lastSubmittedBy = this.userName;
          this.lastFromStage   = this.userDesignation;
          this.lastToStage     = res.toStage;
          this.clearDraft();
          setTimeout(() => this.closeSubmitDialog(), 2000);
        },
        error: (err) => { this.isSubmitting = false; this.submitError = err?.error?.detail || 'Submit failed.'; }
      });
    };

    if (this.existingWorkId) {
      // Already saved — submit directly
      doSubmit(this.existingWorkId);
    } else {
      // New work — save first to get a work_id, then submit
      const payload = {
        nameOfWork:  this.nameOfWork,
        division:    this.selectedDivision,
        circle:      this.selectedCircle,
        ward:        this.selectedWard,
        gstRate:     this.selectedGstRate,
        gstAmount:   this.totals.gst,
        grandTotal:  this.totals.grandTotal,
        submittedBy: this.userName,
        designation: this.userDesignation,
        items:       this.savedItems
      };
      this.http.post<any>(`${this.apiBase}/works/save`, payload).subscribe({
        next: (res) => { doSubmit(res.work_id); },
        error: (err) => { this.isSubmitting = false; this.submitError = 'Could not save work before submitting.'; }
      });
    }
  }

  // ── Generate Sheet ────────────────────────────────────────────
  // ── Save work without submitting ─────────────────────────────
  isSaving:     boolean = false;
  saveSuccess:  string  = '';
  saveError:    string  = '';

  onSaveWork(): void {
    if (!this.nameOfWork.trim()) { this.saveError = 'Please enter a work name.'; return; }
    this.isSaving   = true;
    this.saveError  = '';
    this.saveSuccess= '';

    const payload = {
      nameOfWork:   this.nameOfWork,
      division:     this.selectedDivision,
      circle:       this.selectedCircle,
      ward:         this.selectedWard,
      gstRate:      this.selectedGstRate,
      gstAmount:    this.totals.gst,
      grandTotal:   this.totals.grandTotal,
      submittedBy:  this.userName,
      designation:  this.userDesignation,
      items:        this.savedItems,
      saveDraft:    true   // flag: save but do NOT submit
    };

    const url = this.existingWorkId
      ? `${this.apiBase}/works/${this.existingWorkId}/save`
      : `${this.apiBase}/works/save`;

    this.http.post<any>(url, payload).subscribe({
      next: (res) => {
        this.isSaving       = false;
        this.saveSuccess    = 'Work saved successfully!';
        if (res.work_id) this.existingWorkId = res.work_id;
        this.clearDraft();  // safe to clear now — saved in DB
        setTimeout(() => { this.saveSuccess = ''; }, 3000);
      },
      error: (err) => {
        this.isSaving  = false;
        this.saveError = err?.error?.detail || 'Save failed. Please try again.';
      }
    });
  }

  onGenerateSheet(): void {
    if (!this.nameOfWork.trim()) { alert('Please enter a work name first.'); return; }
    if (this.savedItems.length === 0) { alert('Please add at least one item.'); return; }

    const navigateToAbstract = (workId: string) => {
      this.stateService.setState({
        nameOfWork:  this.nameOfWork,
        division:    this.selectedDivision,
        circle:      this.selectedCircle,
        ward:        this.selectedWard,
        savedItems:  this.savedItems,
        gstRate:     this.selectedGstRate,
        gstAmount:   this.totals.gst,
        grandTotal:  this.totals.grandTotal,
        workId:      workId,
        viewOnly:    false,
        canEdit:     true,
        fromPage:    'prepare-estimate'
      });
      this.router.navigate(['/abstract']);
    };

    if (this.existingWorkId) {
      // Work already saved — go straight to abstract
      navigateToAbstract(this.existingWorkId);
    } else {
      // Save work first to get a workId, then open abstract
      const payload = {
        nameOfWork:  this.nameOfWork,
        division:    this.selectedDivision,
        circle:      this.selectedCircle,
        ward:        this.selectedWard,
        gstRate:     this.selectedGstRate,
        gstAmount:   this.totals.gst,
        grandTotal:  this.totals.grandTotal,
        submittedBy: this.userName,
        designation: this.userDesignation,
        items:       this.savedItems
      };
      this.http.post<any>(`${this.apiBase}/works/save`, payload).subscribe({
        next: (res) => {
          this.existingWorkId = res.work_id;
          this.saveDraft();
          navigateToAbstract(res.work_id);
        },
        error: () => { alert('Could not save work. Please try again.'); }
      });
    }
  }

  goBack(): void { this.router.navigate(['/home']); }
  onLogout(): void { this.auth.logout(); this.router.navigate(['/login']); }

  createEmptyItem(sNo: number): any {
    return { sNo, description: '', numbers: 1, length: 0, breadth: 0, depth: 0, quantity: 0, rate: 0, unit: '', amount: 0, isMaterial: 'No' };
  }
  trackByIndex(index: number, item: any): number { return item.sNo; }
}

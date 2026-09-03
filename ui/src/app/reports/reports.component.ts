import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../login/auth.service';
import { AbstractStateService } from '../work-order/abstract-state.service';

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  templateUrl: './reports.component.html',
  styleUrls: ['./reports.component.css']
})
export class ReportsComponent implements OnInit {
  private apiBase = 'http://localhost:3000/api';

  worksList: any[] = [];
  isLoading = false;
  error = '';

  // ── Search box with suggestions ──────────────────────────────
  // Filters the already-loaded worksList client-side, same approach as
  // Edit Estimate — avoids extra round trips and always matches what's
  // actually shown in the table below.
  searchInput: string = '';
  suggestions: any[] = [];
  showSuggestions: boolean = false;

  constructor(
    private auth: AuthService,
    private http: HttpClient,
    private router: Router,
    private stateService: AbstractStateService
  ) {}

  get user()            { return this.auth.getSession(); }
  get userName()        { return this.user?.name || ''; }
  get userDesignation() { return this.user?.designation || ''; }

  ngOnInit(): void {
    this.loadWorksList();
  }

  loadWorksList(): void {
    this.isLoading = true;
    this.error = '';

    const stage = encodeURIComponent(this.userDesignation);
    const submittedBy = encodeURIComponent(this.userName);
    this.http.get<any[]>(`${this.apiBase}/works?stage=${stage}&submittedBy=${submittedBy}`).subscribe({
      next: (works) => {
        this.worksList = works || [];
        this.isLoading = false;
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Could not load works list.';
        this.isLoading = false;
      }
    });
  }

  openEstimate(work: any): void {
    this.router.navigate(['/prepare-estimate'], { state: { workId: work.work_id, fromPage: 'reports' } });
  }

  openAbstract(work: any, event?: Event): void {
    if (event) event.stopPropagation();
    this.error = '';

    this.http.get<any[]>(`${this.apiBase}/works/${work.work_id}/items`).subscribe({
      next: (items) => {
        this.http.get<any>(`${this.apiBase}/works/${work.work_id}/abstract`).subscribe({
          next: (abstract) => this.navigateToAbstract(work, items, abstract),
          error: () => this.navigateToAbstract(work, items, null)
        });
      },
      error: (err) => {
        this.error = err?.error?.detail || 'Could not open this work.';
      }
    });
  }

  private navigateToAbstract(work: any, items: any[], abstract: any): void {
    const savedItems = (items || []).map((item, index) => ({
      sNo: item.sl_no || index + 1,
      description: item.description,
      numbers: Number(item.numbers) || 0,
      length: Number(item.length) || 0,
      breadth: Number(item.breadth) || 0,
      depth: Number(item.depth) || 0,
      quantity: Number(item.quantity) || 0,
      unit: item.unit || '',
      rate: Number(item.rate) || 0,
      amount: Number(item.amount) || 0,
      isMaterial: item.is_material ? 'Yes' : 'No'
    }));

    const materialTotal = savedItems
      .filter(item => item.isMaterial === 'Yes')
      .reduce((sum, item) => sum + Number(item.amount), 0);
    const civilWorksTotal = savedItems
      .filter(item => item.isMaterial === 'No')
      .reduce((sum, item) => sum + Number(item.amount), 0);

    const gstRate = Number(abstract?.gst_rate) || 0;
    const gstAmount = Number(abstract?.gst_amount) || 0;
    const grandTotal = Number(abstract?.grand_total) || materialTotal + civilWorksTotal + gstAmount;

    this.stateService.setState({
      nameOfWork: work.name_of_work,
      division: work.division || '',
      circle: work.circle || '',
      ward: work.ward || '',
      savedItems,
      gstRate,
      gstAmount,
      grandTotal,
      workId: work.work_id,
      viewOnly: work.display_status === 'submitted',
      canEdit: work.display_status !== 'submitted',
      fromPage: 'reports'
    });
    this.router.navigate(['/abstract']);
  }

  statusLabel(work: any): string {
    return work.display_status === 'submitted' ? 'Submitted' : 'Yet to Submit';
  }

  // ── Search box with suggestions ──────────────────────────────
  onSearchInput(): void {
    const q = this.searchInput.trim().toLowerCase();
    if (!q) { this.suggestions = []; this.showSuggestions = false; return; }

    this.suggestions = this.worksList
      .filter((w: any) =>
        (w.work_id || '').toLowerCase().includes(q) ||
        (w.name_of_work || '').toLowerCase().includes(q)
      )
      .slice(0, 8);
    this.showSuggestions = this.suggestions.length > 0;
  }

  onSelectSuggestion(work: any): void {
    this.searchInput = work.name_of_work || work.work_id;
    this.showSuggestions = false;
  }

  closeSuggestions(): void {
    // Slight delay so a click on a suggestion registers before the list closes
    setTimeout(() => { this.showSuggestions = false; }, 200);
  }

  clearSearch(): void {
    this.searchInput = '';
    this.suggestions = [];
    this.showSuggestions = false;
  }

  // Table below the search box reflects the same filter as the suggestions,
  // so typing narrows the list down directly too.
  get filteredWorksList(): any[] {
    const q = this.searchInput.trim().toLowerCase();
    if (!q) return this.worksList;
    return this.worksList.filter((w: any) =>
      (w.work_id || '').toLowerCase().includes(q) ||
      (w.name_of_work || '').toLowerCase().includes(q)
    );
  }

  goBack(): void { this.router.navigate(['/home']); }
  onLogout(): void { this.auth.logout(); this.router.navigate(['/login']); }
}
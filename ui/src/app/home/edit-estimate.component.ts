import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClientModule, HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { AuthService } from '../login/auth.service';

// Designation → stage flow
const STAGE_FLOW: any = {
  'Manager': 'Manager',
  'DGM':     'DGM',
  'GM':      'GM',
  'CGM':     'CGM',
  'Director':'Director'
};

@Component({
  selector: 'app-edit-estimate',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  templateUrl: './edit-estimate.component.html',
  styleUrls: ['./edit-estimate.component.css']
})
export class EditEstimateComponent implements OnInit {

  private apiBase = 'http://localhost:3000/api';

  // Manual Work ID / Name lookup
  workIdInput: string  = '';
  isChecking:  boolean = false;
  checkError:  string  = '';

  // Suggestions dropdown — filtered from worksList as the user types,
  // since worksList already holds exactly the works this officer can edit.
  suggestions:  any[]    = [];
  showSuggestions: boolean = false;

  // Works list for this stage — only works the user can edit right now.
  // Works already submitted onward show up on the Reports page instead.
  worksList:     any[]   = [];
  isLoadingList: boolean = false;
  listError:     string  = '';

  constructor(
    private auth:   AuthService,
    private http:   HttpClient,
    private router: Router
  ) {}

  get user()            { return this.auth.getSession(); }
  get userName()        { return this.user?.name        || ''; }
  get userDesignation() { return this.user?.designation || ''; }
  get myStage()         { return STAGE_FLOW[this.userDesignation] || ''; }

  ngOnInit(): void {
    this.loadWorksList();
  }

  loadWorksList(): void {
    this.isLoadingList = true;
    this.listError     = '';
    const stage = this.myStage;
    const name  = encodeURIComponent(this.userName);
    const url   = `${this.apiBase}/works?stage=${encodeURIComponent(stage)}&submittedBy=${name}`;
    this.http.get<any[]>(url).subscribe({
      next: (works) => {
        // Only show works currently editable at this user's stage.
        // Works already submitted onward belong on the Reports page, not here.
        this.worksList     = works.filter((w: any) => w.display_status === 'in_progress');
        this.isLoadingList = false;
        // In case the user already typed something before this resolved.
        if (this.workIdInput.trim()) { this.onWorkIdInput(); }
      },
      error: () => {
        this.listError     = 'Could not load works list.';
        this.isLoadingList = false;
      }
    });
  }

  // Opens the work in the Prepare Estimate page for editing, instead of
  // loading it inline on this page.
  selectWork(work: any): void {
    this.router.navigate(['/prepare-estimate'], { state: { workId: work.work_id } });
  }

  // ── Suggestions for the lookup box ───────────────────────────
  // Filters the already-loaded worksList (which only contains works this
  // officer can edit) by work_id or name_of_work as the user types.
  onWorkIdInput(): void {
    const q = this.workIdInput.trim().toLowerCase();
    this.checkError = '';
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
    this.showSuggestions = false;
    this.selectWork(work);
  }

  closeSuggestions(): void {
    // Slight delay so a click on a suggestion registers before the list closes
    setTimeout(() => { this.showSuggestions = false; }, 200);
  }

  onCheckWorkId(): void {
    if (!this.workIdInput.trim()) { this.checkError = 'Please enter a Work ID.'; return; }

    this.isChecking = true;
    this.checkError = '';

    this.http.get<any>(`${this.apiBase}/works/check?workId=${encodeURIComponent(this.workIdInput.trim())}&designation=${encodeURIComponent(this.userDesignation)}`).subscribe({
      next: (res) => {
        this.isChecking = false;

        if (res && res.exists) {
          // Open this work in Prepare Estimate for editing/viewing rather than
          // loading the full form on this page.
          this.router.navigate(['/prepare-estimate'], { state: { workId: res.work_id } });
        } else {
          this.checkError = 'Work ID not found. Use Prepare Estimate to create a new work.';
        }
      },
      error: () => {
        this.isChecking = false;
        this.checkError = 'Work ID not found.';
      }
    });
  }

  goBack(): void { this.router.navigate(['/home']); }
  onLogout(): void { this.auth.logout(); this.router.navigate(['/login']); }
}
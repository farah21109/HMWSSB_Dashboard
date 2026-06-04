import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../login/auth.service';
import { AdminService, AssignmentResponse, JurisdictionOptions, Officer } from './admin.service';

type Level = 'corporation' | 'zone' | 'division' | 'circle' | 'ward' | '';

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin.component.html',
  styleUrls: ['./admin.component.css']
})
export class AdminComponent implements OnInit {
  options: JurisdictionOptions = {
    corporations: [],
    zones: [],
    divisions: [],
    circles: [],
    wards: []
  };

  selection = {
    corporation: '',
    zone: '',
    division: '',
    circle: '',
    ward: ''
  };

  currentLevel: Level = '';
  currentDesignation = '';
  currentAssignment: AssignmentResponse['assignment'] = null;
  eligibleOfficers: Officer[] = [];
  allOfficers: Officer[] = [];
  selectedOfficerKey = '';
  isChangingAssignment = false;

  newOfficer: Officer = {
    key: '',
    name: '',
    contact: '',
    designation: 'Manager'
  };

  designations = ['Manager', 'DGM', 'GM', 'CGM', 'Director'];
  isLoading = false;
  isSaving = false;
  message = '';
  error = '';

  constructor(
    private admin: AdminService,
    private auth: AuthService,
    private router: Router
  ) {}

  get userName(): string { return this.auth.getSession()?.name || 'Admin'; }

  ngOnInit(): void {
    this.loadOptions();
    this.loadAllOfficers();
  }

  onLogout(): void {
    this.auth.logout();
    this.router.navigate(['/login']);
  }

  onCorporationChange(): void {
    this.loadOptions();
    this.loadAssignment();
  }

  onZoneChange(): void {
    this.loadOptions();
    this.loadAssignment();
  }

  onDivisionChange(): void {
    this.loadOptions();
    this.loadAssignment();
  }

  onCircleChange(): void {
    this.selection.ward = '';
    this.loadOptions();
    this.loadAssignment();
  }

  onWardChange(): void {
    this.loadAssignment();
  }

  saveAssignment(): void {
    if (!this.currentLevel) {
      this.error = 'Select a corporation first.';
      return;
    }
    this.isSaving = true;
    this.message = '';
    this.error = '';
    this.admin.updateAssignment({ ...this.selection, level: this.currentLevel }, this.selectedOfficerKey).subscribe({
      next: (res) => {
        this.isSaving = false;
        this.isChangingAssignment = false;
        this.currentAssignment = res.assignment;
        this.message = res.rowsUpdated > 0 ? 'Officer assignment updated.' : 'No jurisdiction rows matched this selection.';
      },
      error: (err) => {
        this.isSaving = false;
        this.error = err?.error?.detail || err?.error?.error || 'Could not update assignment.';
      }
    });
  }

  startChange(): void {
    if (!this.currentLevel) return;
    this.isChangingAssignment = true;
  }

  cancelChange(): void {
    this.isChangingAssignment = false;
    this.selectedOfficerKey = this.currentAssignment?.officer_key || '';
  }

  formatDivision(value: string): string {
    return value ? `Division ${value}` : '';
  }

  get departmentName(): string {
    if (this.selection.ward) return this.selection.ward;
    if (this.selection.circle) return this.selection.circle;
    if (this.selection.division) return this.formatDivision(this.selection.division);
    if (this.selection.zone) return this.selection.zone;
    if (this.selection.corporation) return this.selection.corporation;
    return '';
  }

  private loadOptions(): void {
    this.admin.getOptions(this.selection).subscribe({
      next: (options) => { this.options = options; },
      error: (err) => { this.error = err?.error?.detail || 'Could not load jurisdiction options.'; }
    });
  }

  private loadAllOfficers(): void {
    this.admin.getOfficers().subscribe({
      next: (officers) => { this.allOfficers = officers; },
      error: () => { this.allOfficers = []; }
    });
  }

  private loadEligibleOfficers(designation: string): void {
    this.admin.getOfficers(designation).subscribe({
      next: (officers) => { this.eligibleOfficers = officers; },
      error: () => { this.eligibleOfficers = []; }
    });
  }

  private loadAssignment(): void {
    this.message = '';
    this.error = '';
    this.currentLevel = this.detectLevel();
    this.isChangingAssignment = false;
    this.currentAssignment = null;
    this.currentDesignation = '';
    this.selectedOfficerKey = '';
    this.eligibleOfficers = [];

    if (!this.currentLevel) return;

    this.isLoading = true;
    this.admin.getAssignment({ ...this.selection, level: this.currentLevel }).subscribe({
      next: (res) => {
        this.isLoading = false;
        this.currentDesignation = res.designation;
        this.currentAssignment = res.assignment;
        this.selectedOfficerKey = res.assignment?.officer_key || '';
        this.loadEligibleOfficers(res.designation);
      },
      error: (err) => {
        this.isLoading = false;
        this.error = err?.error?.detail || err?.error?.error || 'Could not load current assignment.';
      }
    });
  }

  private detectLevel(): Level {
    if (this.selection.ward) return 'ward';
    if (this.selection.circle) return 'circle';
    if (this.selection.division) return 'division';
    if (this.selection.zone) return 'zone';
    if (this.selection.corporation) return 'corporation';
    return '';
  }
}

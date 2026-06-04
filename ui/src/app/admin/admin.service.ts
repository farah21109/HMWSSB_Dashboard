import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface JurisdictionOptions {
  corporations: string[];
  zones: string[];
  divisions: string[];
  circles: string[];
  wards: string[];
}

export interface Officer {
  key: string;
  name: string;
  contact: string;
  designation: string;
}

export interface AssignmentResponse {
  level: string;
  designation: string;
  assignment: {
    officer_key: string;
    officer_name: string;
    officer_contact: string;
  } | null;
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private apiBase = 'http://localhost:3000/api';

  constructor(private http: HttpClient) {}

  getOptions(selection: any): Observable<JurisdictionOptions> {
    let params = new HttpParams();
    ['corporation', 'zone', 'division', 'circle'].forEach(field => {
      if (selection[field]) params = params.set(field, selection[field]);
    });
    return this.http.get<JurisdictionOptions>(`${this.apiBase}/admin/jurisdiction/options`, { params });
  }

  getOfficers(designation?: string): Observable<Officer[]> {
    const params = designation ? new HttpParams().set('designation', designation) : undefined;
    return this.http.get<Officer[]>(`${this.apiBase}/admin/officers`, { params });
  }

  saveOfficer(officer: Officer): Observable<{ success: boolean; officer: Officer }> {
    return this.http.post<{ success: boolean; officer: Officer }>(`${this.apiBase}/admin/officers`, officer);
  }

  deleteOfficer(key: string): Observable<{ success: boolean; removed: Officer | null }> {
    return this.http.delete<{ success: boolean; removed: Officer | null }>(
      `${this.apiBase}/admin/officers/${encodeURIComponent(key)}`
    );
  }

  getAssignment(selection: any): Observable<AssignmentResponse> {
    let params = new HttpParams();
    ['level', 'corporation', 'zone', 'division', 'circle', 'ward'].forEach(field => {
      if (selection[field]) params = params.set(field, selection[field]);
    });
    return this.http.get<AssignmentResponse>(`${this.apiBase}/admin/assignment`, { params });
  }

  updateAssignment(selection: any, officerKey: string): Observable<any> {
    return this.http.put(`${this.apiBase}/admin/assignment`, { ...selection, officerKey });
  }
}

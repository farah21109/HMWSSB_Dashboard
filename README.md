# Works Module

A web application for preparing, reviewing and approving **work estimates and abstracts** across a municipal hierarchy. Officers prepare an estimate from a schedule of rates, send it up through the approval chain, and senior officers can return it with remarks. Each officer sees only the works that belong to their own ward, circle or division.

---

## Contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [How the approval workflow works](#how-the-approval-workflow-works)
4. [Who sees what (jurisdiction isolation)](#who-sees-what-jurisdiction-isolation)
5. [Project structure](#project-structure)
6. [Getting started](#getting-started)
7. [Configuration](#configuration)
8. [Admin area](#admin-area)
9. [API overview](#api-overview)
10. [Database notes](#database-notes)
11. [Known limitations](#known-limitations)

---

## Features

**For officers**
- **Prepare Estimate**: create a new work, search the item list while typing, add quantities and rates, and save progress as a draft.
- **Edit Estimate**: reopen works you created that are still at your stage and keep editing them.
- **Reports**: see every work in your jurisdiction, open its estimate or abstract, and track its current status and stage.
- **Abstract**: generate the general abstract for a work.
- **Excel export**: download the estimate sheet as an Excel file.
- **Submit**: send a work to the next stage of approval.
- **Return**: a senior officer can send a work back to the previous stage with mandatory remarks. The officer who receives it sees a *Returned* badge and the remarks.

**For the administrator**
- **Jurisdiction Assignment**: assign officers to a ward, circle, division, zone or corporation.
- **Manage Officers**: add new officers (with a login) and remove those who leave or retire. Removed officers disappear from the screen and can no longer log in, but their records stay in the database.
- **Add Items**: add new items (description, unit, rate) to the item list that officers search while preparing estimates.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Angular 17 (standalone components), TypeScript, RxJS |
| Backend | Node.js, Express 4 |
| Database | PostgreSQL (via `pg`) |
| Excel export | SheetJS (`xlsx`) |

---

## How the approval workflow works

A work moves up through five stages, one level at a time:

```
Manager  →  DGM  →  GM  →  CGM  →  Director
```

- A work starts at the stage of the officer who creates it.
- **Submit** moves it to the next stage up.
- **Return** moves it back to the previous stage, with remarks that are saved with the work.
- Only the officer whose stage currently holds the work can submit or return it.

---

## Who sees what (jurisdiction isolation)

Each designation is tied to one level of the hierarchy:

| Designation | Level | Sees works whose… |
|---|---|---|
| Manager | Ward | division, circle and ward match theirs |
| DGM | Circle | division and circle match theirs |
| GM | Division | division matches theirs |
| CGM | Zone | division is within their zone |
| Director | Corporation | everything |

The hierarchy is:

```
Corporation  →  Zone  →  Division  →  Circle  →  Ward
```

For example, if a GM returns a work from Ward 194 to the DGM stage, only the DGM of that work's circle can see it. DGMs of other circles cannot, and neither can a circle with the same number in a different division.

Matching ignores spaces, letter case and dash type, so `2 – Alwal` and `2 - Alwal` are treated as the same.

The Edit Estimate page is narrower still: it lists only works that *you created* and that are still at your stage. Works you received from someone else appear on the Reports page.

---

## Project structure

```
works-module/
├── backend/
│   ├── server.js            Express API (all routes and business rules)
│   ├── db.js                PostgreSQL connection pool
│   ├── migrations/          SQL migrations
│   ├── package.json
│   └── .env                 Database credentials (not committed)
└── ui/
    ├── angular.json
    ├── package.json
    └── src/app/
        ├── login/           Login page and AuthService
        ├── home/            Home menu, Prepare Estimate, Edit Estimate
        ├── reports/         Reports list, Return dialog
        ├── abstract/        General abstract
        ├── work-order/      Excel export and shared services
        ├── admin/           Jurisdiction Assignment, Manage Officers, Add Items
        ├── auth.guard.ts    Protects officer pages
        ├── admin.guard.ts   Protects admin pages
        └── app.routes.ts    Route table
```

### Pages

| Route | Page | Access |
|---|---|---|
| `/login` | Login | Everyone |
| `/home` | Home menu | Officers |
| `/prepare-estimate` | Prepare Estimate | Officers |
| `/edit-estimate` | Edit Estimate | Officers |
| `/reports` | Reports | Officers |
| `/abstract` | General Abstract | Officers |
| `/admin` | Jurisdiction Assignment | Admin only |
| `/admin/officers` | Manage Officers | Admin only |
| `/admin/items` | Add Items | Admin only |

---

## Getting started

### Prerequisites

- Node.js 18 or later
- PostgreSQL
- Angular CLI 17 (`npm install -g @angular/cli`)

### 1. Backend

```bash
cd backend
npm install
```

Create a `.env` file in `backend/` (see [Configuration](#configuration)), then start the server:

```bash
npm start          # or: npm run dev   (auto-restart with nodemon)
```

The API runs at `http://localhost:3000`. On startup you should see:

```
✅ Connected to PostgreSQL successfully
Soft-delete columns ready (officers, users).
```

### 2. Frontend

```bash
cd ui
npm install
ng serve
```

Open `http://localhost:4200` and log in.

### 3. Production build

```bash
cd ui
ng build
```

The build output is written to `ui/dist/`.

---

## Configuration

Create `backend/.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database_name
DB_USER=your_postgres_user
DB_PASSWORD=your_postgres_password
PORT=3000
```

> Never commit `.env` to version control. It holds your database password.

The frontend calls the API at `http://localhost:3000/api`. If you deploy the backend elsewhere, update the `apiBase` value in the Angular services.

---

## Admin area

Admin pages are available only to a user whose designation is **Admin**.

- The Angular `AdminGuard` keeps other users away from the admin routes.
- At admin login, the server issues a session token. Every `/api/admin/*` request must send it in the `x-admin-token` header, so the endpoints are protected even if someone calls them directly.
- The token is held in server memory, so after the backend restarts the admin simply logs in again.

### Manage Officers

- **Add**: designation, name, 10-digit contact number, username and password. This creates the officer record and the login together. The username is the officer's key.
- **Edit**: update name, contact number or reset the password.
- **Remove**: a soft delete. The officer is unassigned from their areas, hidden from the list, and blocked from logging in. Their rows stay in the database.
- **Assigned To**: the list shows where each officer works, at their own level (for example `Zone Malkajgiri` for a CGM or `Ward 194 - Bhudevi Nagar` for a Manager).

### Add Items

Adds a new row to the items table. The serial number is assigned automatically (highest existing number plus one), and an item whose description matches an existing one is rejected. New items show up in the officers' search straight away.

---

## API overview

All routes are under `/api`.

**Authentication**

| Method | Route | Purpose |
|---|---|---|
| POST | `/login` | Log in. Returns the user and, for an admin, a session token |
| GET | `/my-jurisdiction` | Dropdown options for the logged-in officer |

**Items**

| Method | Route | Purpose |
|---|---|---|
| GET | `/items/search` | Suggestions while typing an item description |
| GET | `/items/:slno` | Fetch one item |
| GET | `/items` | List items |

**Works**

| Method | Route | Purpose |
|---|---|---|
| GET | `/works` | List works in the officer's jurisdiction |
| GET | `/works/check` | Look up a work by ID or name |
| POST | `/works/save` | Save a new work |
| POST | `/works/:workId/save` | Save an existing work |
| GET | `/works/:workId/items` | Estimate items of a work |
| GET | `/works/:workId/abstract` | Abstract of a work |
| PUT | `/works/:workId/items` | Update estimate items |
| POST | `/works/:workId/submit` | Send to the next stage |
| POST | `/works/:workId/return` | Send back to the previous stage with remarks |

**Admin** (require the `x-admin-token` header)

| Method | Route | Purpose |
|---|---|---|
| GET | `/admin/jurisdiction/options` | Corporation, zone, division, circle and ward options |
| GET / PUT | `/admin/assignment` | View or change the officer assigned to an area |
| GET | `/admin/officers` | List active officers |
| POST | `/admin/officers` | Add an officer and login |
| PUT | `/admin/officers/:key` | Edit an officer |
| DELETE | `/admin/officers/:key` | Remove (soft delete) an officer |
| GET | `/admin/officers/:key/assignments` | Where an officer is currently assigned |
| POST | `/admin/items` | Add an item |

**Utility**

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Server health check |

---

## Database notes

Main tables used by the application:

| Table | Purpose |
|---|---|
| `users` | Login accounts (username, password, designation, name, contact) |
| `officers` | Officer records shown in the admin screens |
| `jurisdiction` | One row per ward, holding the officer assigned at each level (`manager_key`, `dgm_key`, `gm_key`, `cgm_key`, `director_key`) |
| `finished` | The item list (schedule of rates) that officers search |
| `work_order_items` | The estimate lines of each work, with its current stage and status |
| `abstracts` | Abstract data for each work |
| `work_submissions` | History of every submit and return, with remarks |

**Schema upgrade at startup.** The backend adds `is_active` and `deleted_at` columns to `officers` and `users` if they are missing. It is safe to run repeatedly and does not change existing data.

**Removed officers.** Officers are never hard-deleted. They are flagged inactive so their history stays intact.

**Backups.** Take a database backup before upgrading, especially before the first run that adds the soft-delete columns.

---

## Known limitations

- **Passwords are stored as plain text** in the `users` table. Hash them (for example with bcrypt) before any real deployment.
- **No server-side login sessions for officers.** The server trusts the designation and username sent by the browser. Only admin routes are protected by a token.
- **Admin tokens live in memory**, so a backend restart logs the admin out.
- **Item search** matches text anywhere in a description and returns at most 30 results in alphabetical order.
- The `/api/debug/*` routes are meant for development. Remove or protect them in production.
- The API address is hard-coded to `http://localhost:3000`.

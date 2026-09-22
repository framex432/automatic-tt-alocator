import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  LayoutDashboard, Database, Users, Calendar, AlertTriangle, BarChart3,
  Settings as SettingsIcon, Search, Bell, ChevronRight, ChevronDown, X, Plus,
  Printer, Download, FileText, Check, Clock, GraduationCap, Layers, MapPin,
  TrendingUp, Menu, Pencil, Trash2, ArrowRight, Sparkles, User, Mail, Phone,
  FlaskConical, RefreshCw, CheckCircle2, AlertCircle, Building2, BookOpen,
  Filter, ChevronLeft, DoorClosed,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { loadState, syncDiff } from './db';
import { supabase } from './supabaseClient';
import { jsPDF } from 'jspdf';
import { generateTimetableWithAI, parseChangeRequest, isGrokConfigured } from './grok';
import { generateForClasses, planForClassSection, findOrphanEntries, coverageForClass, isCombinedPair } from './solver';
import { applyChangeOps } from './editor';

const T = {
  primary: '#1C3F6E',
  primaryDark: '#122A4C',
  primaryTint: '#EAF0F8',
  ink: '#12151C',
  muted: '#64748B',
  bg: '#F5F6F8',
  surface: '#FFFFFF',
  border: '#E3E6EB',
  critical: '#C63C3C',
  criticalTint: '#FBEAEA',
  warn: '#B4790F',
  warnTint: '#FBF1DF',
  success: '#1D7A55',
  successTint: '#E9F6EF',
};

// Entity-aware navigation: maps a state collection key to the entity "type" used by
// search results and notifications, and maps each entity type to the Master Data tab
// that owns it. This is the single source of truth for "where does this entity live"
// so no navigation path ever has to hardcode a fallback to Master Data's default tab.
const ENTITY_TYPE_BY_KEY = {
  faculty: 'faculty',
  subjects: 'subject',
  departments: 'department',
  classrooms: 'classroom',
  labs: 'lab',
};
const MASTER_TAB_BY_TYPE = {
  subject: 'Subjects',
  department: 'Departments',
  classroom: 'Classrooms & Labs',
  lab: 'Classrooms & Labs',
};
// The login screen only ever shows a password field — this fixed email is what
// actually goes to Supabase Auth behind the scenes. It's not a secret (anyone
// could read it from the built JS), but that's fine: it identifies *which*
// account to authenticate as — the password is what's actually checked.
// Swappable for real per-staff accounts or Google sign-in later without
// touching the RLS policies, which only care about "authenticated" vs not.
const STAFF_LOGIN_EMAIL = 'staff@timesyncai.local';

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

function seedData() {
  const departments = [
    { id: 'CSE', name: 'Computer Science & Engineering' },
    { id: 'AIDS', name: 'Artificial Intelligence & Data Science' },
    { id: 'IT', name: 'Information Technology' },
    { id: 'ECE', name: 'Electronics & Communication Engineering' },
    { id: 'EEE', name: 'Electrical & Electronics Engineering' },
    { id: 'MECH', name: 'Mechanical Engineering' },
  ];

  const dayOrders = [
    { id: 'DO1', label: 'I', actualDay: 'Monday' },
    { id: 'DO2', label: 'II', actualDay: 'Tuesday' },
    { id: 'DO3', label: 'III', actualDay: 'Wednesday' },
    { id: 'DO4', label: 'IV', actualDay: 'Thursday' },
    { id: 'DO5', label: 'V', actualDay: 'Friday' },
    { id: 'DO6', label: 'VI', actualDay: 'Saturday' },
  ];

  const periods = [
    { id: 'P1', label: 'Period 1', start: '09:15 AM', end: '10:15 AM', type: 'period' },
    { id: 'P2', label: 'Period 2', start: '10:15 AM', end: '11:15 AM', type: 'period' },
    { id: 'B1', label: 'Break', start: '11:15 AM', end: '11:30 AM', type: 'break' },
    { id: 'P3', label: 'Period 3', start: '11:30 AM', end: '12:30 PM', type: 'period' },
    { id: 'L1', label: 'Lunch', start: '12:30 PM', end: '01:15 PM', type: 'break' },
    { id: 'P4', label: 'Period 4', start: '01:15 PM', end: '02:15 PM', type: 'period' },
    { id: 'P5', label: 'Period 5', start: '02:15 PM', end: '03:15 PM', type: 'period' },
    { id: 'B2', label: 'Break', start: '03:15 PM', end: '03:30 PM', type: 'break' },
    { id: 'P6', label: 'Period 6', start: '03:30 PM', end: '04:30 PM', type: 'period' },
  ];

  const faculty = [
    { id: 'FAC-CSE-001', name: 'Dr. K. Nagappan', departmentId: 'CSE', designation: 'Professor', email: 'nagappan.k@sinct.edu', phone: '9840012345', subjectIds: ['SUB-CSE-DS'], maxWeeklyHours: 20, availability: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    { id: 'FAC-CSE-002', name: 'Mr. J. Johny Sebastian', departmentId: 'CSE', designation: 'Assistant Professor', email: 'johny.j@sinct.edu', phone: '9840012346', subjectIds: ['SUB-CSE-JAVA'], maxWeeklyHours: 20, availability: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] },
    { id: 'FAC-CSE-003', name: 'Mrs. S. Elamathi', departmentId: 'CSE', designation: 'Assistant Professor', email: 'elamathi.s@sinct.edu', phone: '9840012347', subjectIds: ['SUB-CSE-OS', 'SUB-CSE-OSL'], maxWeeklyHours: 20, availability: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    { id: 'FAC-AIDS-001', name: 'Mr. G. Bharathikannan', departmentId: 'AIDS', designation: 'Assistant Professor', email: 'bharathi.g@sinct.edu', phone: '9840012348', subjectIds: [], maxWeeklyHours: 20, availability: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    { id: 'FAC-AIDS-002', name: 'Mrs. S. Ganga', departmentId: 'AIDS', designation: 'Assistant Professor', email: 'ganga.s@sinct.edu', phone: '9840012349', subjectIds: ['SUB-AIDS-DM'], maxWeeklyHours: 20, availability: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    { id: 'FAC-IT-001', name: 'Mrs. V. Dhavamani', departmentId: 'IT', designation: 'Assistant Professor', email: 'dhavamani.v@sinct.edu', phone: '9840012350', subjectIds: ['SUB-IT-OOSE'], maxWeeklyHours: 20, availability: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
  ];

  const subjects = [
    { id: 'SUB-CSE-DS', code: 'CS25C08', name: 'Data Structures', departmentIds: ['CSE'], year: 'III', semester: 5, type: 'Theory', facultyIds: ['FAC-CSE-001'], weeklyHours: 5, labRequired: false },
    { id: 'SUB-CSE-JAVA', code: 'CS25C09', name: 'Java Programming', departmentIds: ['CSE'], year: 'III', semester: 5, type: 'Theory', facultyIds: ['FAC-CSE-002'], weeklyHours: 4, labRequired: false },
    { id: 'SUB-CSE-OS', code: 'CS25C10', name: 'Operating Systems', departmentIds: ['CSE'], year: 'III', semester: 5, type: 'Theory', facultyIds: ['FAC-CSE-003'], weeklyHours: 4, labRequired: false },
    { id: 'SUB-CSE-OSL', code: 'CS25C10L', name: 'Operating Systems Laboratory', departmentIds: ['CSE'], year: 'III', semester: 5, type: 'Lab', facultyIds: ['FAC-CSE-003'], weeklyHours: 2, labRequired: true },
    { id: 'SUB-AIDS-AI', code: 'AD25C05', name: 'Artificial Intelligence', departmentIds: ['AIDS'], year: 'III', semester: 5, type: 'Theory', facultyIds: ['FAC-AIDS-001', 'FAC-CSE-001'], weeklyHours: 5, labRequired: false },
    { id: 'SUB-AIDS-DM', code: 'AD25C03', name: 'Discrete Mathematics', departmentIds: ['AIDS'], year: 'III', semester: 5, type: 'Theory', facultyIds: ['FAC-AIDS-002'], weeklyHours: 4, labRequired: false },
    { id: 'SUB-IT-OOSE', code: 'IT25C06', name: 'Object Oriented Software Engineering', departmentIds: ['IT'], year: 'III', semester: 5, type: 'Theory', facultyIds: ['FAC-IT-001'], weeklyHours: 4, labRequired: false },
    // Example of a subject shared across multiple departments in the same year,
    // e.g. a common Maths paper taught to CSE, AIDS and IT II-year students alike.
    { id: 'SUB-COMMON-MATH2', code: 'MA25C02', name: 'Mathematics II', departmentIds: ['CSE', 'AIDS', 'IT'], year: 'II', semester: 3, type: 'Theory', facultyIds: [], weeklyHours: 4, labRequired: false },
  ];

  const classrooms = [
    { id: 'ROOM-CFF01', name: 'CFF01', type: 'classroom', capacity: 60, departmentId: 'CSE' },
    { id: 'ROOM-CFF02', name: 'CFF02', type: 'classroom', capacity: 60, departmentId: 'AIDS' },
    { id: 'ROOM-CFF03', name: 'CFF03', type: 'classroom', capacity: 60, departmentId: 'IT' },
  ];

  const labs = [
    { id: 'LAB-DS', name: 'Data Structures Lab', type: 'lab', capacity: 30, departmentId: 'CSE' },
    { id: 'LAB-JAVA', name: 'Java Programming Lab', type: 'lab', capacity: 30, departmentId: 'CSE' },
    { id: 'LAB-OS', name: 'Operating Systems Lab', type: 'lab', capacity: 30, departmentId: 'CSE' },
    { id: 'LAB-AI', name: 'AI Lab', type: 'lab', capacity: 30, departmentId: 'AIDS' },
  ];

  const classSections = [
    { id: 'CLS-CSE-3A', departmentId: 'CSE', batch: '2024\u20132028', year: 'III', semester: 5, section: 'A', roomId: 'ROOM-CFF01' },
    { id: 'CLS-AIDS-3A', departmentId: 'AIDS', batch: '2024\u20132028', year: 'III', semester: 5, section: 'A', roomId: 'ROOM-CFF02' },
  ];

  const timetableEntries = [
    { id: uid('TT'), departmentId: 'CSE', classSectionId: 'CLS-CSE-3A', dayOrderId: 'DO1', periodId: 'P1', subjectId: 'SUB-CSE-DS', facultyId: 'FAC-CSE-001', roomId: 'ROOM-CFF01', type: 'theory' },
    { id: uid('TT'), departmentId: 'CSE', classSectionId: 'CLS-CSE-3A', dayOrderId: 'DO2', periodId: 'P3', subjectId: 'SUB-CSE-DS', facultyId: 'FAC-CSE-001', roomId: 'ROOM-CFF01', type: 'theory' },
    { id: uid('TT'), departmentId: 'CSE', classSectionId: 'CLS-CSE-3A', dayOrderId: 'DO1', periodId: 'P4', subjectId: 'SUB-CSE-JAVA', facultyId: 'FAC-CSE-002', roomId: 'ROOM-CFF01', type: 'theory' },
    { id: uid('TT'), departmentId: 'CSE', classSectionId: 'CLS-CSE-3A', dayOrderId: 'DO3', periodId: 'P3', subjectId: 'SUB-CSE-OS', facultyId: 'FAC-CSE-003', roomId: 'ROOM-CFF01', type: 'theory' },
    { id: uid('TT'), departmentId: 'AIDS', classSectionId: 'CLS-AIDS-3A', dayOrderId: 'DO1', periodId: 'P1', subjectId: 'SUB-AIDS-AI', facultyId: 'FAC-CSE-001', roomId: 'ROOM-CFF02', type: 'theory' },
    { id: uid('TT'), departmentId: 'AIDS', classSectionId: 'CLS-AIDS-3A', dayOrderId: 'DO2', periodId: 'P1', subjectId: 'SUB-AIDS-DM', facultyId: 'FAC-AIDS-002', roomId: 'ROOM-CFF02', type: 'theory' },
  ];

  return {
    college: { name: 'Sir Issac Newton College of Engineering and Technology', academicYear: '2026\u20132027', workingDays: 'Monday \u2013 Saturday', numPeriods: 6 },
    departments, dayOrders, periods, faculty, subjects, classrooms, labs, classSections, timetableEntries,
    classAssignments: [],
    activityLog: [
      { id: uid('ACT'), text: 'New faculty added: Dr. Arun Kumar', ts: Date.now() - 1000 * 60 * 60 },
    ],
  };
}

function computeConflicts(state) {
  const subjectsById = new Map(state.subjects.map((s) => [s.id, s]));
  const bySlot = {};
  state.timetableEntries.forEach((e) => {
    const key = e.dayOrderId + '|' + e.periodId;
    if (!bySlot[key]) bySlot[key] = [];
    bySlot[key].push(e);
  });
  const conflicts = [];
  Object.values(bySlot).forEach((entries) => {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i], b = entries[j];
        // A common (multi-department) subject taught by the SAME faculty to different
        // departments in the same slot is one combined lecture, not a double-booking.
        if (isCombinedPair(a, b, subjectsById)) continue;
        if (a.facultyId && b.facultyId && a.facultyId === b.facultyId) {
          conflicts.push(makeConflict('faculty', a, b, state));
        }
        if (a.roomId && b.roomId && a.roomId === b.roomId && a.classSectionId !== b.classSectionId) {
          conflicts.push(makeConflict('classroom', a, b, state));
        }
        if (a.classSectionId === b.classSectionId && a.id !== b.id) {
          conflicts.push(makeConflict('class', a, b, state));
        }
      }
    }
  });
  return conflicts;
}

function makeConflict(type, a, b, state) {
  const fac = state.faculty.find((f) => f.id === a.facultyId);
  const classA = state.classSections.find((c) => c.id === a.classSectionId);
  const classB = state.classSections.find((c) => c.id === b.classSectionId);
  const subjA = state.subjects.find((s) => s.id === a.subjectId);
  const subjB = state.subjects.find((s) => s.id === b.subjectId);
  const dayOrder = state.dayOrders.find((d) => d.id === a.dayOrderId);
  const period = state.periods.find((p) => p.id === a.periodId);
  let message = '';
  if (type === 'faculty') message = fac ? fac.name + ' is booked for two classes in the same slot.' : 'Faculty is double-booked.';
  if (type === 'classroom') message = 'This room is booked for two different classes in the same slot.';
  if (type === 'class') message = (classA ? classA.departmentId + ' ' + classA.section : 'This class') + ' has two subjects scheduled in the same slot.';
  return {
    id: a.id + '__' + b.id + '__' + type,
    type,
    severity: 'critical',
    facultyId: a.facultyId,
    dayOrderId: a.dayOrderId,
    periodId: a.periodId,
    entryA: a,
    entryB: b,
    classA, classB, subjA, subjB, fac, dayOrder, period,
    message,
  };
}

function aiSuggestions(entry, state) {
  const periodSlots = state.periods.filter((p) => p.type === 'period');
  const options = [];
  for (const d of state.dayOrders) {
    for (const p of periodSlots) {
      if (d.id === entry.dayOrderId && p.id === entry.periodId) continue;
      const clash = state.timetableEntries.some((e) => e.id !== entry.id && e.dayOrderId === d.id && e.periodId === p.id &&
        (e.facultyId === entry.facultyId || e.roomId === entry.roomId || e.classSectionId === entry.classSectionId));
      if (!clash) {
        options.push({ dayOrderId: d.id, periodId: p.id, dayLabel: d.actualDay, doLabel: d.label, periodLabel: p.label });
        if (options.length >= 3) return options;
      }
    }
  }
  return options;
}

// Faculty other than the one currently booked who can ALSO teach this subject
// (subject.facultyIds) and are free at this exact day/period across the whole
// college. Unlike aiSuggestions (which needs an empty CELL for the whole class,
// impossible once a class's grid is completely full), this needs no free cell
// at all - it just swaps who teaches the already-scheduled slot, so it still
// works when the class has zero spare periods.
function alternateFacultyOptions(entry, subject, state) {
  if (!subject) return [];
  const day = state.dayOrders.find((d) => d.id === entry.dayOrderId);
  return (subject.facultyIds || [])
    .filter((id) => id !== entry.facultyId)
    .map((id) => state.faculty.find((f) => f.id === id))
    .filter(Boolean)
    .filter((f) => !(Array.isArray(f.availability) && day && !f.availability.includes(day.actualDay)))
    .filter((f) => !state.timetableEntries.some((e) => e.id !== entry.id && e.facultyId === f.id && e.dayOrderId === entry.dayOrderId && e.periodId === entry.periodId));
}

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' minute' + (min === 1 ? '' : 's') + ' ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + ' hour' + (hr === 1 ? '' : 's') + ' ago';
  return Math.floor(hr / 24) + ' day(s) ago';
}

// Rolling 7-day window (not calendar-week) — an entry is kept as long as it's
// less than 7*24h old, and pruned once it crosses that age, regardless of what
// day of the week "today" happens to be.
function isWithinPastWeek(ts, now) {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  return now - ts < WEEK_MS;
}

function Badge({ children, tone = 'default' }) {
  const tones = {
    default: { bg: T.primaryTint, color: T.primary },
    critical: { bg: T.criticalTint, color: T.critical },
    warn: { bg: T.warnTint, color: T.warn },
    success: { bg: T.successTint, color: T.success },
    gray: { bg: '#F0F1F3', color: T.muted },
  };
  const s = tones[tone] || tones.default;
  return (
    <span style={{ background: s.bg, color: s.color }} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold">
      {children}
    </span>
  );
}

const Card = React.forwardRef(function Card({ children, className = '', style = {}, onClick }, ref) {
  return (
    <div ref={ref} onClick={onClick} className={'rounded-2xl border ' + className} style={{ background: T.surface, borderColor: T.border, ...style }}>
      {children}
    </div>
  );
});

function PrimaryButton({ children, onClick, icon: Icon, className = '', type = 'button', disabled }) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={'inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors ' + className}
      style={{ background: disabled ? '#B9C4D2' : T.primary, color: '#fff', cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      {Icon && <Icon size={15} />}
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, icon: Icon, className = '', tone, disabled = false }) {
  const color = tone === 'critical' ? T.critical : T.ink;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 ' + className}
      style={{ borderColor: T.border, color }}
    >
      {Icon && <Icon size={14} />}
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle = { borderColor: T.border, color: T.ink };
const inputClass = 'w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2';

function Select(props) {
  return <select {...props} className={inputClass + ' bg-white ' + (props.className || '')} style={{ ...inputStyle, ...(props.style || {}) }} />;
}
function Input(props) {
  return <input {...props} className={inputClass + ' ' + (props.className || '')} style={{ ...inputStyle, ...(props.style || {}) }} />;
}

function Drawer({ open, onClose, title, children, width = 420 }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0" style={{ background: 'rgba(18,21,28,0.35)' }} onClick={onClose} />
      <div className="relative z-10 flex h-full flex-col shadow-xl" style={{ width, maxWidth: '92vw', background: T.surface }}>
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: T.border }}>
          <h3 className="ts-display text-base font-semibold" style={{ color: T.ink }}>{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-gray-100"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

function Modal({ open, onClose, title, children, width = 560 }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
      <div className="absolute inset-0" style={{ background: 'rgba(18,21,28,0.35)' }} onClick={onClose} />
      <div className="relative z-10 flex max-h-[88vh] flex-col overflow-hidden rounded-2xl shadow-xl" style={{ width, maxWidth: '95vw', background: T.surface }}>
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: T.border }}>
          <h3 className="ts-display text-base font-semibold" style={{ color: T.ink }}>{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-gray-100"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  );
}

function LoginModal({ open, onClose, toast }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: STAFF_LOGIN_EMAIL,
      password,
    });
    setBusy(false);
    if (signInError) {
      setError('Incorrect password.');
      return;
    }
    setPassword('');
    toast('Signed in.');
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title="Staff sign in" width={360}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            autoFocus
          />
        </Field>
        {error && <p className="text-xs" style={{ color: T.critical }}>{error}</p>}
        <PrimaryButton type="submit" disabled={busy || !password} className="w-full justify-center">
          {busy ? 'Signing in\u2026' : 'Sign in'}
        </PrimaryButton>
      </form>
    </Modal>
  );
}

function EmptyState({ title, subtitle, actionLabel, onAction, icon: Icon = Database }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed py-16 text-center" style={{ borderColor: T.border }}>
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full" style={{ background: T.primaryTint }}>
        <Icon size={22} color={T.primary} />
      </div>
      <p className="ts-display text-sm font-semibold" style={{ color: T.ink }}>{title}</p>
      <p className="mt-1 max-w-xs text-sm" style={{ color: T.muted }}>{subtitle}</p>
      {actionLabel && <div className="mt-4"><PrimaryButton icon={Plus} onClick={onAction}>{actionLabel}</PrimaryButton></div>}
    </div>
  );
}

function ProgressBar({ value, max = 100, color = T.primary }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: '#EEF1F4' }}>
      <div className="h-full rounded-full transition-all" style={{ width: pct + '%', background: color }} />
    </div>
  );
}

function StatCard({ label, value, sub, icon: Icon, tone = 'default' }) {
  const tones = {
    default: T.primary, critical: T.critical, success: T.success, warn: T.warn,
  };
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: T.muted }}>{label}</p>
          <p className="ts-display mt-1.5 text-2xl font-semibold" style={{ color: T.ink }}>{value}</p>
          {sub && <p className="mt-1 text-xs" style={{ color: T.muted }}>{sub}</p>}
        </div>
        {Icon && (
          <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: T.primaryTint }}>
            <Icon size={16} color={tones[tone] || T.primary} />
          </div>
        )}
      </div>
    </Card>
  );
}

const NAV = [
  { section: null, items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  { section: 'Management', items: [
    { id: 'master', label: 'Master Data', icon: Database },
    { id: 'facultyDetails', label: 'Faculty Details', icon: Users },
  ] },
  { section: 'Scheduling', items: [
    { id: 'createTimetable', label: 'Create Timetable', icon: Calendar },
    { id: 'conflictCenter', label: 'Conflict Center', icon: AlertTriangle },
    { id: 'timetableOverview', label: 'Timetable Overview', icon: Layers },
  ] },
  { section: 'Analytics', items: [
    { id: 'workload', label: 'Faculty Workload', icon: TrendingUp },
    { id: 'analytics', label: 'Schedule Analytics', icon: BarChart3 },
  ] },
  { section: 'System', items: [{ id: 'settings', label: 'Settings', icon: SettingsIcon }] },
];

// Catches any render-time error anywhere below it and shows a recoverable message
// instead of letting React silently unmount to a blank white screen — which is
// exactly the failure mode this app hit repeatedly before (missing env vars, a
// bad export path, etc). Whatever the future bug turns out to be, staff should
// see *something* actionable, not a blank page with zero clues.
class TimeSyncErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Time Sync AI crashed:', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-full flex-col items-center justify-center gap-3 p-6 text-center" style={{ background: T.bg }}>
          <AlertTriangle size={32} color={T.critical} />
          <p className="ts-display text-base font-semibold" style={{ color: T.ink }}>Something went wrong.</p>
          <p className="max-w-md text-sm" style={{ color: T.muted }}>
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-2 rounded-lg px-4 py-2 text-sm font-semibold text-white"
            style={{ background: T.primary }}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function TimeSyncAIInner() {
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifDetailOpen, setNotifDetailOpen] = useState(false);
  // Auth: viewing is public (no login needed), but every add/edit/delete requires
  // a signed-in session. The login screen only ever asks for a password — the
  // fixed staff email lives here, out of the person's sight, so it still goes
  // through real Supabase Auth (and can be swapped for Google sign-in later)
  // instead of being a purely cosmetic client-side check.
  const [session, setSession] = useState(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [globalFacultyId, setGlobalFacultyId] = useState(null);
  const [facultyModalOpen, setFacultyModalOpen] = useState(false);
  const [facultyDeptFilter, setFacultyDeptFilter] = useState('ALL');
  const [masterTab, setMasterTab] = useState('College');
  const [overviewDept, setOverviewDept] = useState('ALL');
  // Set when "Edit" is clicked on a class's card in Timetable Overview, so Create
  // Timetable opens with that exact class (department + year + section) pre-selected
  // and confirmed instead of landing on its blank "Select class" step.
  const [editClassTarget, setEditClassTarget] = useState(null);
  // focusEntity tracks which specific record a search result / notification pointed at,
  // so the destination page can scroll to it and highlight it instead of just landing
  // on the module's default view.
  const [focusEntity, setFocusEntity] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const fresh = await loadState();
        // Drop any notification older than 7 days before it ever reaches the UI. We
        // still fire a background syncDiff (not just local state) so this prune also
        // deletes those rows from Supabase via the normal diff-sync path — otherwise
        // they'd just reappear next reload.
        const now = Date.now();
        const withinWeek = fresh.activityLog.filter((a) => isWithinPastWeek(a.ts, now));
        const pruned = withinWeek.length === fresh.activityLog.length ? fresh : { ...fresh, activityLog: withinWeek };
        setState(pruned);
        if (pruned !== fresh) {
          syncDiff(fresh, pruned).catch((err) => {
            // eslint-disable-next-line no-console
            console.error('Failed to prune old notifications', err);
          });
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('Failed to load state from Supabase, falling back to local seed data.', e);
        toast('Could not reach the database \u2014 showing local demo data.', 'critical');
        setState(seedData());
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the login session separately from data loading — viewing works with
  // or without a session (RLS allows public SELECT), so this never blocks the
  // initial render, it only affects whether write actions are allowed.
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const toast = useCallback((msg, tone = 'success') => {
    const id = uid('TOAST');
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const persist = useCallback((next) => {
    if (!session) {
      // Viewing never needs a login (RLS allows public SELECT), but every write
      // does. Gating here — the one place every add/update/delete already flows
      // through — covers all of them without touching each call site.
      setLoginOpen(true);
      toast('Please sign in to make changes.', 'critical');
      return;
    }
    const prev = state;
    // Optimistic: update the UI immediately, sync to Supabase in the background.
    setState(next);
    syncDiff(prev, next).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Supabase sync failed', err);
      // Roll back to the last known-good state — without this, a rejected change
      // (e.g. deleting a department that still has faculty/subjects assigned, which
      // the database correctly refuses) would keep showing as "deleted" on screen
      // even though it's still there in Supabase, until the next reload.
      setState(prev);
      const friendly = /class_assignments/i.test(err?.message || '') && /find the table|does not exist|schema cache/i.test(err?.message || '')
        ? 'The class-allocation table is missing. Run supabase-migration-class-assignments.sql in the Supabase SQL editor, then reload.'
        : /foreign key|violates|restrict/i.test(err?.message || '')
        ? 'That can\u2019t be removed while other records still depend on it. Reassign or delete those first, then try again.'
        : 'Change could not be saved: ' + (err?.message || 'unknown error') + '. Nothing was changed.';
      toast(friendly, 'critical');
    });
  }, [state, toast, session]);

  const logActivity = useCallback((base, text, entityRef = null) => {
    const entry = {
      id: uid('ACT'),
      text,
      ts: Date.now(),
      entityType: entityRef?.entityType ?? null,
      entityId: entityRef?.entityId ?? null,
    };
    // Generous cap just to stop this array growing without bound between reloads —
    // the real retention limit is the 7-day prune that runs on load, not this number.
    return { ...base, activityLog: [entry, ...base.activityLog].slice(0, 300) };
  }, []);

  const addRecord = useCallback((key, record, activityText) => {
    let next = { ...state, [key]: [...state[key], record] };
    if (activityText) {
      const entityType = ENTITY_TYPE_BY_KEY[key];
      next = logActivity(next, activityText, entityType ? { entityType, entityId: record.id } : null);
    }
    persist(next);
  }, [state, persist, logActivity]);

  const updateRecord = useCallback((key, id, patch, activityText) => {
    let next = { ...state, [key]: state[key].map((x) => (x.id === id ? { ...x, ...patch } : x)) };
    if (activityText) {
      const entityType = ENTITY_TYPE_BY_KEY[key];
      next = logActivity(next, activityText, entityType ? { entityType, entityId: id } : null);
    }
    persist(next);
  }, [state, persist, logActivity]);

  const deleteRecord = useCallback((key, id, activityText) => {
    let next = { ...state, [key]: state[key].filter((x) => x.id !== id) };
    if (activityText) {
      // Don't attach entityId here — the record is gone, so a notification that tried
      // to "open" it would have nothing to highlight. entityType alone still routes
      // the click to the right Master Data tab.
      const entityType = ENTITY_TYPE_BY_KEY[key];
      next = logActivity(next, activityText, entityType ? { entityType, entityId: null } : null);
    }
    persist(next);
  }, [state, persist, logActivity]);

  const updateCollege = useCallback((patch) => {
    persist({ ...state, college: { ...state.college, ...patch } });
  }, [state, persist]);

  const resetDemoData = useCallback(() => {
    const fresh = seedData();
    persist(fresh);
    toast('Demo data reset.');
  }, [persist, toast]);

  const conflicts = useMemo(() => (state ? computeConflicts(state) : []), [state]);

  // Single, scalable entry point for "go to the exact record this entityType/entityId
  // refers to". Every click handler that used to hardcode navigate('/master-data') or
  // setPage('master') for non-faculty entities should route through here instead, so
  // adding a new entity type only ever means adding one line to the maps above.
  const openEntity = useCallback((entityType, entityId) => {
    if (!entityType) { setPage('master'); setFocusEntity(null); return; }

    if (entityType === 'faculty') {
      setGlobalFacultyId(entityId);
      setPage('facultyDetails');
      setFocusEntity(null);
      return;
    }

    if (entityType === 'timetable') {
      // entityId here is a departmentId (the app doesn't model timetables as their own
      // entity with an id yet - see final report, "remaining issues").
      setOverviewDept(entityId || 'ALL');
      setPage('timetableOverview');
      setFocusEntity(null);
      return;
    }

    if (entityType === 'conflict') {
      setPage('conflictCenter');
      setFocusEntity({ type: entityType, id: entityId });
      return;
    }

    const tab = MASTER_TAB_BY_TYPE[entityType];
    if (tab) {
      setPage('master');
      setMasterTab(tab);
      setFocusEntity({ type: entityType, id: entityId });
      return;
    }

    // Genuinely unknown entity type: this is the ONLY remaining fallback to Master
    // Data's default tab, and it only fires for a type we don't recognize at all.
    setPage('master');
    setMasterTab('College');
    setFocusEntity(null);
  }, []);

  // Jump to Create Timetable with one specific class (from its Timetable Overview
  // card) pre-selected, instead of the usual blank "Select class" step.
  const openClassForEdit = useCallback((cs) => {
    setEditClassTarget({ departmentId: cs.departmentId, year: cs.year, section: cs.section });
    setPage('createTimetable');
  }, []);

  const actions = {
    addRecord, updateRecord, deleteRecord, updateCollege, resetDemoData, toast, persist, logActivity,
    setPage, setGlobalFacultyId, setFacultyModalOpen, setFacultyDeptFilter, openEntity, openClassForEdit,
  };

  if (loading || !state) {
    return (
      <div className="ts-body flex h-screen w-full items-center justify-center" style={{ background: T.bg }}>
        <style>{fontStyles}</style>
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2" style={{ borderColor: T.primaryTint, borderTopColor: T.primary }} />
          <p className="text-sm" style={{ color: T.muted }}>Loading Time Sync AI{'\u2026'}</p>
        </div>
      </div>
    );
  }

  const searchResults = getSearchResults(searchQuery, state);

  return (
    <div className="ts-body flex h-screen w-full overflow-hidden" style={{ background: T.bg }}>
      <style>{fontStyles}</style>

      {sidebarOpen && (
        <div className="fixed inset-0 z-30 md:hidden" onClick={() => setSidebarOpen(false)} style={{ background: 'rgba(18,21,28,0.4)' }} />
      )}

      <aside
        className={'no-print z-40 flex w-64 shrink-0 flex-col border-r transition-transform md:relative md:translate-x-0 ' +
          (sidebarOpen ? 'fixed inset-y-0 left-0 translate-x-0' : 'fixed inset-y-0 left-0 -translate-x-full md:flex')}
        style={{ background: T.surface, borderColor: T.border }}
      >
        <div className="flex items-center gap-2.5 border-b px-5 py-5" style={{ borderColor: T.border }}>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: T.primary }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="9" cy="9" r="7.5" stroke="#fff" strokeWidth="1.4" />
              <path d="M9 4.5V9L12 11" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <p className="ts-display text-sm font-bold leading-tight" style={{ color: T.ink }}>TIME SYNC AI</p>
            <p className="text-[11px] font-medium" style={{ color: T.muted }}>Academic Intelligence</p>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV.map((group, gi) => (
            <div key={gi} className="mb-4">
              {group.section && (
                <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: T.muted }}>{group.section}</p>
              )}
              {group.items.map((item) => {
                const active = page === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => { setPage(item.id); setSidebarOpen(false); setFocusEntity(null); setOverviewDept('ALL'); setEditClassTarget(null); }}
                    className="mb-0.5 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors"
                    style={{ background: active ? T.primaryTint : 'transparent', color: active ? T.primary : T.ink }}
                  >
                    <item.icon size={16} />
                    <span className="flex-1">{item.label}</span>
                    {item.id === 'conflictCenter' && conflicts.length > 0 && (
                      <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ background: T.critical, color: '#fff' }}>{conflicts.length}</span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="flex items-center gap-2.5 border-t px-4 py-4" style={{ borderColor: T.border }}>
          <div className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold" style={{ background: T.primaryTint, color: T.primary }}>CA</div>
          <div className="leading-tight">
            <p className="text-xs font-semibold" style={{ color: T.ink }}>Administrator</p>
            <p className="text-[11px]" style={{ color: T.muted }}>College Admin</p>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex items-center gap-3 border-b px-4 py-3 md:px-6" style={{ borderColor: T.border, background: T.surface }}>
          <button className="rounded-md p-1.5 hover:bg-gray-100 md:hidden" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <div className="min-w-0 flex-1">
            <p className="ts-display truncate text-[15px] font-semibold" style={{ color: T.ink }}>{pageTitle(page)}</p>
          </div>

          <div className="relative hidden w-72 sm:block">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" color={T.muted} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search faculty, subjects, departments\u2026"
              className="w-full rounded-lg border py-1.5 pl-8 pr-3 text-sm outline-none"
              style={inputStyle}
            />
            {searchQuery && (
              <div className="absolute left-0 right-0 top-10 z-30 max-h-72 overflow-y-auto rounded-lg border shadow-lg" style={{ background: T.surface, borderColor: T.border }}>
                {searchResults.length === 0 && <p className="px-3 py-3 text-xs" style={{ color: T.muted }}>No matches.</p>}
                {searchResults.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => {
                      setSearchQuery('');
                      openEntity(r.type, r.id);
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50"
                  >
                    <span style={{ color: T.ink }}>{r.label}</span>
                    <Badge tone="gray">{r.type}</Badge>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button className="relative rounded-md p-2 hover:bg-gray-100" onClick={() => setNotifOpen((v) => !v)}>
              <Bell size={18} color={T.ink} />
              {conflicts.length > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full" style={{ background: T.critical }} />}
            </button>
            {notifOpen && (
              <div className="absolute right-0 top-11 z-30 w-72 rounded-lg border shadow-lg" style={{ background: T.surface, borderColor: T.border }}>
                <div className="border-b px-3 py-2 text-xs font-semibold" style={{ borderColor: T.border, color: T.muted }}>Notifications</div>
                <div className="max-h-64 overflow-y-auto">
                  {conflicts.slice(0, 4).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => { setNotifOpen(false); openEntity('conflict', c.id); }}
                      className="block w-full border-b px-3 py-2.5 text-left text-xs hover:bg-gray-50"
                      style={{ borderColor: T.border }}
                    >
                      <p className="font-semibold" style={{ color: T.critical }}>Faculty conflict detected</p>
                      <p style={{ color: T.muted }}>{c.classA?.departmentId} {'\u00d7'} {c.classB?.departmentId}</p>
                    </button>
                  ))}
                  {state.activityLog.length === 0 && conflicts.length === 0 && (
                    <p className="px-3 py-4 text-center text-xs" style={{ color: T.muted }}>No notifications yet.</p>
                  )}
                  {/* Only the 2 most recent — click any one to see everything logged today. */}
                  {state.activityLog.slice(0, 2).map((a) => (
                    <button
                      key={a.id}
                      onClick={() => { setNotifOpen(false); setNotifDetailOpen(true); }}
                      className="block w-full border-b px-3 py-2.5 text-left text-xs last:border-0 hover:bg-gray-50"
                      style={{ borderColor: T.border }}
                    >
                      <p style={{ color: T.ink }}>{a.text}</p>
                      <p style={{ color: T.muted }}>{timeAgo(a.ts)}</p>
                    </button>
                  ))}
                </div>
                {state.activityLog.length > 2 && (
                  <button
                    onClick={() => { setNotifOpen(false); setNotifDetailOpen(true); }}
                    className="block w-full px-3 py-2 text-center text-xs font-semibold hover:bg-gray-50"
                    style={{ color: T.primary }}
                  >
                    View this week{'\u2019'}s activity
                  </button>
                )}
              </div>
            )}
          </div>

          {session ? (
            <button
              onClick={async () => { await supabase.auth.signOut(); toast('Signed out.'); }}
              className="rounded-md px-3 py-2 text-sm font-medium hover:bg-gray-100"
              style={{ color: T.muted }}
              title="Signed in \u2014 click to sign out"
            >
              Sign out
            </button>
          ) : (
            <PrimaryButton onClick={() => setLoginOpen(true)}>Sign in</PrimaryButton>
          )}

          <Modal open={notifDetailOpen} onClose={() => setNotifDetailOpen(false)} title="This week's activity" width={480}>
            <div className="max-h-96 -mx-1 space-y-1 overflow-y-auto px-1">
              {state.activityLog.length === 0 && (
                <p className="py-6 text-center text-sm" style={{ color: T.muted }}>Nothing logged in the past week.</p>
              )}
              {state.activityLog.map((a) => (
                <button
                  key={a.id}
                  onClick={() => { if (a.entityType) { setNotifDetailOpen(false); openEntity(a.entityType, a.entityId); } }}
                  className="block w-full rounded-lg border px-3 py-2.5 text-left text-sm hover:bg-gray-50"
                  style={{ borderColor: T.border, cursor: a.entityType ? 'pointer' : 'default' }}
                >
                  <p style={{ color: T.ink }}>{a.text}</p>
                  <p className="text-xs" style={{ color: T.muted }}>{timeAgo(a.ts)}</p>
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs" style={{ color: T.muted }}>
              Notifications are kept for 7 days {'\u2014'} anything older is cleared automatically.
            </p>
          </Modal>

          <LoginModal open={loginOpen} onClose={() => setLoginOpen(false)} toast={toast} />
        </header>

        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {page === 'dashboard' && <Dashboard state={state} conflicts={conflicts} actions={actions} />}
          {page === 'master' && (
            <MasterData
              state={state} actions={actions} facultyModalOpen={facultyModalOpen} setFacultyModalOpen={setFacultyModalOpen}
              tab={masterTab} setTab={(t) => { setMasterTab(t); setFocusEntity(null); }}
              highlight={focusEntity}
            />
          )}
          {page === 'facultyDetails' && (
            <FacultyDetails
              state={state} actions={actions} conflicts={conflicts}
              globalFacultyId={globalFacultyId} setGlobalFacultyId={setGlobalFacultyId}
              deptFilter={facultyDeptFilter} setDeptFilter={setFacultyDeptFilter}
            />
          )}
          {page === 'createTimetable' && <CreateTimetable state={state} actions={actions} conflicts={conflicts} initialClass={editClassTarget} />}
          {page === 'conflictCenter' && <ConflictCenter state={state} actions={actions} conflicts={conflicts} highlightId={focusEntity?.type === 'conflict' ? focusEntity.id : null} />}
          {page === 'timetableOverview' && <TimetableOverview state={state} conflicts={conflicts} initialDept={overviewDept} onEditClass={openClassForEdit} />}
          {page === 'workload' && <FacultyWorkload state={state} />}
          {page === 'analytics' && <ScheduleAnalytics state={state} conflicts={conflicts} />}
          {page === 'settings' && <SettingsPage state={state} actions={actions} />}
        </main>
      </div>

      {facultyModalOpen && <AddFacultyModal state={state} actions={actions} onClose={() => setFacultyModalOpen(false)} />}

      <div className="no-print fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg" style={{ background: T.ink, color: '#fff' }}>
            <CheckCircle2 size={15} color={t.tone === 'critical' ? '#F5A3A3' : '#8FE3B8'} />
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function TimeSyncAI() {
  return (
    <TimeSyncErrorBoundary>
      <TimeSyncAIInner />
    </TimeSyncErrorBoundary>
  );
}

function pageTitle(page) {
  const map = {
    dashboard: 'Good evening, Administrator',
    master: 'Master Data',
    facultyDetails: 'Faculty Details',
    createTimetable: 'Create Timetable',
    conflictCenter: 'Conflict Center',
    timetableOverview: 'Timetable Overview',
    workload: 'Faculty Workload',
    analytics: 'Schedule Analytics',
    settings: 'Settings',
  };
  return map[page] || 'Time Sync AI';
}

function getSearchResults(q, state) {
  if (!q || q.length < 2) return [];
  const query = q.toLowerCase();
  const norm = (v) => (v || '').toLowerCase();
  const results = [];
  state.faculty.forEach((f) => { if (norm(f.name).includes(query)) results.push({ key: 'f-' + f.id, id: f.id, type: 'faculty', label: f.name }); });
  state.subjects.forEach((s) => { if (norm(s.name).includes(query) || norm(s.code).includes(query)) results.push({ key: 's-' + s.id, id: s.id, type: 'subject', label: s.name }); });
  state.departments.forEach((d) => { if (norm(d.name).includes(query) || norm(d.id).includes(query)) results.push({ key: 'd-' + d.id, id: d.id, type: 'department', label: d.name }); });
  (state.classrooms || []).forEach((r) => { if (norm(r.name).includes(query)) results.push({ key: 'c-' + r.id, id: r.id, type: 'classroom', label: r.name }); });
  (state.labs || []).forEach((r) => { if (norm(r.name).includes(query)) results.push({ key: 'l-' + r.id, id: r.id, type: 'lab', label: r.name }); });
  return results.slice(0, 8);
}

function Dashboard({ state, conflicts, actions }) {
  const { departments, faculty, classSections, timetableEntries } = state;
  const facultyConflicts = conflicts.filter((c) => c.type === 'faculty').length;
  const roomConflicts = conflicts.filter((c) => c.type === 'classroom').length;
  const classConflicts = conflicts.filter((c) => c.type === 'class').length;
  const health = Math.max(0, 100 - conflicts.length * 4);

  const weekly = state.dayOrders.map((d) => ({
    name: d.label,
    entries: timetableEntries.filter((e) => e.dayOrderId === d.id).length,
  }));

  const deptHealth = departments.slice(0, 4).map((d) => {
    const total = timetableEntries.filter((e) => e.departmentId === d.id).length || 1;
    const bad = conflicts.filter((c) => c.classA?.departmentId === d.id || c.classB?.departmentId === d.id).length;
    return { id: d.id, pct: Math.max(0, Math.round(100 - (bad / total) * 100)) };
  });

  return (
    <div>
      <Card className="mb-6 p-5" style={{ background: T.primary, borderColor: T.primary }}>
        <p className="ts-display text-lg font-semibold text-white">Academic Scheduling Command Center</p>
        <p className="mt-1 text-sm" style={{ color: '#C9D8EC' }}>Monitor faculty, departments, resources and timetable conflicts across the college.</p>
      </Card>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Departments" value={departments.length} icon={Building2} />
        <StatCard label="Faculty" value={faculty.length} icon={Users} />
        <StatCard label="Active classes" value={classSections.length} icon={GraduationCap} />
        <StatCard label="Timetables" value={departments.filter((d) => timetableEntries.some((e) => e.departmentId === d.id)).length} icon={Calendar} />
        <StatCard label="Active conflicts" value={conflicts.length} icon={AlertTriangle} tone="critical" />
        <StatCard label="Schedule health" value={health + '%'} icon={TrendingUp} tone="success" />
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Weekly schedule overview</p>
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weekly}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: T.muted }} axisLine={{ stroke: T.border }} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: T.muted }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid ' + T.border }} />
                <Bar dataKey="entries" fill={T.primary} radius={[4, 4, 0, 0]} name="Scheduled classes" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-4">
          <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Conflict summary</p>
          <div className="space-y-3">
            {[
              { label: 'Faculty conflicts', value: facultyConflicts },
              { label: 'Room conflicts', value: roomConflicts },
              { label: 'Class conflicts', value: classConflicts },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between rounded-lg px-3 py-2" style={{ background: row.value > 0 ? T.criticalTint : T.bg }}>
                <span className="text-sm" style={{ color: T.ink }}>{row.label}</span>
                <span className="ts-mono text-sm font-bold" style={{ color: row.value > 0 ? T.critical : T.muted }}>{row.value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Recent activity</p>
          <div className="space-y-1">
            {conflicts.length > 0 && (
              <div className="flex items-start gap-2.5 border-b py-2.5" style={{ borderColor: T.border }}>
                <AlertCircle size={15} color={T.critical} className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium" style={{ color: T.ink }}>Faculty conflict detected</p>
                  <p className="text-xs" style={{ color: T.muted }}>{conflicts[0].classA?.departmentId} {'\u00d7'} {conflicts[0].classB?.departmentId}</p>
                </div>
              </div>
            )}
            {state.activityLog.slice(0, 5).map((a) => (
              <div key={a.id} className="flex items-start gap-2.5 border-b py-2.5 last:border-0" style={{ borderColor: T.border }}>
                <Check size={15} color={T.success} className="mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium" style={{ color: T.ink }}>{a.text}</p>
                  <p className="text-xs" style={{ color: T.muted }}>{timeAgo(a.ts)}</p>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-4">
          <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Department schedule health</p>
          <div className="space-y-3">
            {deptHealth.map((d) => (
              <div key={d.id}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span style={{ color: T.ink }}>{d.id}</span>
                  <span className="ts-mono font-semibold" style={{ color: T.muted }}>{d.pct}%</span>
                </div>
                <ProgressBar value={d.pct} color={d.pct < 90 ? T.warn : T.success} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

const MASTER_TABS = ['College', 'Day Orders', 'Periods', 'Departments', 'Faculty', 'Subjects', 'Classrooms & Labs'];

function MasterData({ state, actions, facultyModalOpen, setFacultyModalOpen, tab: controlledTab, setTab: setControlledTab, highlight }) {
  // Supports an uncontrolled fallback (internal state) so this component still works if
  // ever rendered without the lifted tab/highlight props.
  const [internalTab, setInternalTab] = useState('College');
  const tab = controlledTab ?? internalTab;
  const setTab = setControlledTab ?? setInternalTab;

  return (
    <div>
      <p className="mb-4 text-sm" style={{ color: T.muted }}>Configure your college once. Reuse the information everywhere.</p>
      <div className="mb-5 flex gap-1 overflow-x-auto rounded-lg p-1" style={{ background: '#EEF1F4' }}>
        {MASTER_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
            style={{ background: tab === t ? T.surface : 'transparent', color: tab === t ? T.primary : T.muted, boxShadow: tab === t ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'College' && <CollegeTab state={state} actions={actions} />}
      {tab === 'Day Orders' && <DayOrdersTab state={state} actions={actions} />}
      {tab === 'Periods' && <PeriodsTab state={state} actions={actions} />}
      {tab === 'Departments' && <DepartmentsTab state={state} actions={actions} highlightId={highlight?.type === 'department' ? highlight.id : null} />}
      {tab === 'Faculty' && <FacultyTab state={state} actions={actions} onAdd={() => setFacultyModalOpen(true)} />}
      {tab === 'Subjects' && <SubjectsTab state={state} actions={actions} highlightId={highlight?.type === 'subject' ? highlight.id : null} />}
      {tab === 'Classrooms & Labs' && (
        <RoomsTab
          state={state} actions={actions}
          highlightId={highlight?.type === 'classroom' || highlight?.type === 'lab' ? highlight.id : null}
        />
      )}
    </div>
  );
}

// Shared "flash and scroll to" behaviour for a record opened via search / notification.
// Returns [isFlashing, ref] - attach ref to the row/card and spread the flashing state
// into its highlight styling.
function useFlashHighlight(highlightId, id) {
  const active = highlightId != null && highlightId === id;
  const [flashing, setFlashing] = useState(active);
  const ref = React.useRef(null);
  useEffect(() => {
    if (active) {
      setFlashing(true);
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const t = setTimeout(() => setFlashing(false), 2200);
      return () => clearTimeout(t);
    }
  }, [active, highlightId]);
  return [flashing, ref];
}

function CollegeTab({ state, actions }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(state.college);
  useEffect(() => setForm(state.college), [state.college]);
  return (
    <Card className="max-w-xl p-5">
      {!editing ? (
        <div className="space-y-4">
          {[
            ['College name', form.name],
            ['Academic year', form.academicYear],
            ['Working days', form.workingDays],
            ['Number of periods', form.numPeriods],
          ].map(([label, val]) => (
            <div key={label} className="flex items-center justify-between border-b pb-3 last:border-0" style={{ borderColor: T.border }}>
              <span className="text-sm" style={{ color: T.muted }}>{label}</span>
              <span className="text-sm font-semibold" style={{ color: T.ink }}>{val}</span>
            </div>
          ))}
          <GhostButton icon={Pencil} onClick={() => setEditing(true)}>Edit</GhostButton>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="College name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Academic year"><Input value={form.academicYear} onChange={(e) => setForm({ ...form, academicYear: e.target.value })} /></Field>
          <Field label="Working days"><Input value={form.workingDays} onChange={(e) => setForm({ ...form, workingDays: e.target.value })} /></Field>
          <Field label="Number of periods"><Input type="number" value={form.numPeriods} onChange={(e) => setForm({ ...form, numPeriods: Number(e.target.value) })} /></Field>
          <div className="flex gap-2 pt-2">
            <PrimaryButton onClick={() => { actions.updateCollege(form); setEditing(false); actions.toast('College settings saved.'); }}>Save changes</PrimaryButton>
            <GhostButton onClick={() => { setForm(state.college); setEditing(false); }}>Cancel</GhostButton>
          </div>
        </div>
      )}
    </Card>
  );
}

function DayOrdersTab({ state, actions }) {
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return (
    <div>
      <p className="mb-3 text-sm" style={{ color: T.muted }}>Day Order is the primary academic scheduling unit {'\u2014'} timetables are built against Day Orders, not fixed weekdays.</p>
      <Card className="max-w-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: T.bg }}>
              <th className="px-4 py-2.5 text-left font-semibold" style={{ color: T.muted }}>Day order</th>
              <th className="px-4 py-2.5 text-left font-semibold" style={{ color: T.muted }}>Actual day</th>
              <th className="px-4 py-2.5 text-left font-semibold" style={{ color: T.muted }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {state.dayOrders.map((d) => (
              <tr key={d.id} className="border-t" style={{ borderColor: T.border }}>
                <td className="ts-mono px-4 py-2.5 font-semibold" style={{ color: T.ink }}>{d.label}</td>
                <td className="px-4 py-2.5">
                  <Select value={d.actualDay} onChange={(e) => { actions.updateRecord('dayOrders', d.id, { actualDay: e.target.value }, 'Day Order ' + d.label + ' set to ' + e.target.value); actions.toast('Day order updated.'); }} className="w-40">
                    {weekdays.map((w) => <option key={w} value={w}>{w}</option>)}
                  </Select>
                </td>
                <td className="px-4 py-2.5"><Badge tone="success">Active</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function PeriodsTab({ state, actions }) {
  const [form, setForm] = useState({ label: '', start: '', end: '', type: 'period' });
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
      <Card className="p-4 lg:col-span-2">
        <div className="relative space-y-0">
          {state.periods.map((p, idx) => (
            <div key={p.id} className="relative flex items-center gap-3 py-2.5">
              <div className="flex flex-col items-center">
                <div className="h-2.5 w-2.5 rounded-full" style={{ background: p.type === 'break' ? T.warn : T.primary }} />
                {idx < state.periods.length - 1 && <div className="h-8 w-px" style={{ background: T.border }} />}
              </div>
              <div className="flex flex-1 items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: T.border }}>
                <div>
                  <p className="text-sm font-semibold" style={{ color: T.ink }}>{p.label}</p>
                  <p className="ts-mono text-xs" style={{ color: T.muted }}>{p.start} {'\u2013'} {p.end}</p>
                </div>
                <button onClick={() => { actions.deleteRecord('periods', p.id, 'Period removed: ' + p.label); actions.toast('Period removed.'); }} className="rounded-md p-1.5 hover:bg-gray-100">
                  <Trash2 size={14} color={T.critical} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card className="h-fit p-4">
        <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Add period or break</p>
        <div className="space-y-3">
          <Field label="Label"><Input placeholder="Period 7" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field>
          <Field label="Start time"><Input placeholder="04:30 PM" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field>
          <Field label="End time"><Input placeholder="05:30 PM" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="period">Period</option>
              <option value="break">Break</option>
            </Select>
          </Field>
          <PrimaryButton
            icon={Plus}
            onClick={() => {
              if (!form.label || !form.start || !form.end) { actions.toast('Fill in all fields.', 'critical'); return; }
              actions.addRecord('periods', { id: uid('PD'), ...form }, 'Period added: ' + form.label);
              setForm({ label: '', start: '', end: '', type: 'period' });
              actions.toast('Period added.');
            }}
          >
            Add
          </PrimaryButton>
        </div>
      </Card>
    </div>
  );
}

function DepartmentCard({ d, state, actions, highlightId }) {
  // Own component instance (not inline in a .map callback) so useFlashHighlight's
  // hooks have a stable call order regardless of how many departments exist.
  const facCount = state.faculty.filter((f) => f.departmentId === d.id).length;
  const subCount = state.subjects.filter((s) => (s.departmentIds || []).includes(d.id)).length;
  // classes \u2260 classrooms: a class_sections row can exist purely because someone
  // opened Create Timetable and clicked "Load class" (see ensureClassSection) without
  // ever actually scheduling anything - that row is stale/empty and shouldn't block
  // deletion. Only a class section with at least one real timetable entry against it
  // is a genuine dependency.
  const deptClassSections = state.classSections.filter((c) => c.departmentId === d.id);
  const realClassSections = deptClassSections.filter((c) => state.timetableEntries.some((e) => e.classSectionId === c.id));
  const staleClassSections = deptClassSections.filter((c) => !state.timetableEntries.some((e) => e.classSectionId === c.id));
  const clsCount = realClassSections.length;
  const totalClasses = deptClassSections.length;
  const [flashing, ref] = useFlashHighlight(highlightId, d.id);
  const [showClasses, setShowClasses] = useState(false);

  // Classes of this department, I-year first, then by section.
  const sortedClasses = [...deptClassSections].sort((a, b) =>
    (YEAR_OPTIONS.indexOf(a.year) - YEAR_OPTIONS.indexOf(b.year)) || String(a.section).localeCompare(String(b.section)));

  function fixBatch(c) {
    const batch = batchForYear(state, c.year);
    actions.persist(actions.logActivity(
      { ...state, classSections: state.classSections.map((x) => (x.id === c.id ? { ...x, batch, semester: semesterForYear(c.year) } : x)) },
      'Batch corrected: ' + classLabel(state, c) + ' -> ' + batch,
      { entityType: 'department', entityId: d.id },
    ));
    actions.toast(classLabel(state, c) + ': batch set to ' + batch + '.', 'success');
  }

  function deleteClass(c) {
    const periods = state.timetableEntries.filter((e) => e.classSectionId === c.id).length;
    const allocated = (state.classAssignments || []).filter((a) => a.classSectionId === c.id).length;
    const label = classLabel(state, c);
    const extra = [periods > 0 && periods + ' timetable period(s)', allocated > 0 && allocated + ' staff allocation(s)'].filter(Boolean).join(' and ');
    if (!window.confirm('Delete class ' + label + '?' + (extra ? ' Its ' + extra + ' will be deleted too.' : '') + ' This cannot be undone.')) return;
    actions.persist(actions.logActivity(
      {
        ...state,
        classSections: state.classSections.filter((x) => x.id !== c.id),
        timetableEntries: state.timetableEntries.filter((e) => e.classSectionId !== c.id),
        classAssignments: (state.classAssignments || []).filter((a) => a.classSectionId !== c.id),
      },
      'Class removed: ' + label,
      { entityType: 'department', entityId: d.id },
    ));
    actions.toast('Class ' + label + ' deleted.', 'success');
  }

  return (
    <Card
      ref={ref}
      className="cursor-pointer p-4 transition-shadow hover:shadow-md"
      style={flashing ? { boxShadow: `0 0 0 2px ${T.primary}`, background: T.primaryTint } : {}}
      onClick={() => { actions.setFacultyDeptFilter(d.id); actions.setPage('facultyDetails'); }}
    >
      <div className="mb-3 flex items-center justify-between">
        <Badge>{d.id}</Badge>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (facCount > 0 || subCount > 0 || clsCount > 0) {
              actions.toast('Can\u2019t delete ' + d.name + ' \u2014 it still has ' + [
                facCount > 0 && facCount + ' faculty',
                subCount > 0 && subCount + ' subjects',
                clsCount > 0 && clsCount + ' classes',
              ].filter(Boolean).join(', ') + '. Reassign or remove those first.', 'critical');
              return;
            }
            // Clear out any stale/empty class_sections rows for this department in the
            // same save as the delete, so they never dangle behind and never come back
            // to block a future department delete either.
            const next = staleClassSections.length
              ? {
                  ...state,
                  classSections: state.classSections.filter((c) => c.departmentId !== d.id),
                  classAssignments: (state.classAssignments || []).filter((a) => !staleClassSections.some((c) => c.id === a.classSectionId)),
                }
              : state;
            actions.persist(actions.logActivity({ ...next, departments: next.departments.filter((x) => x.id !== d.id) }, 'Department removed: ' + d.name));
            actions.toast('Department removed.');
          }}
          className="rounded-md p-1 hover:bg-gray-100"
        >
          <Trash2 size={13} color={T.critical} />
        </button>
      </div>
      <p className="ts-display text-sm font-semibold" style={{ color: T.ink }}>{d.name}</p>
      <div className="mt-3 flex gap-4 text-xs" style={{ color: T.muted }}>
        <span>{facCount} faculty</span>
        <span>{subCount} subjects</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setShowClasses((v) => !v); }}
          className="inline-flex items-center gap-1 rounded-md px-1.5 font-semibold underline decoration-dotted underline-offset-2 hover:bg-gray-100"
          style={{ color: T.primary }}
          title="Show / hide the classes of this department"
        >
          {totalClasses} classes
          {showClasses ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>

      {showClasses && (
        <div className="mt-3 border-t pt-2" style={{ borderColor: T.border }} onClick={(e) => e.stopPropagation()}>
          {sortedClasses.length === 0 ? (
            <p className="py-2 text-xs" style={{ color: T.muted }}>No classes yet. Use "Add classes to an existing department" below.</p>
          ) : (
            <ul className="space-y-1">
              {sortedClasses.map((c) => {
                const periods = state.timetableEntries.filter((e) => e.classSectionId === c.id).length;
                const allocated = (state.classAssignments || []).filter((a) => a.classSectionId === c.id).length;
                return (
                  <li key={c.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-gray-50">
                    <div>
                      <span className="font-semibold" style={{ color: T.ink }}>{deptClassSections.filter((x) => x.year === c.year).length > 1 ? c.year + ' year \u2013 Section ' + c.section : c.year + ' year'}</span>
                      <span className="ml-2" style={{ color: T.muted }}>
                        {c.batch ? c.batch + ' \u00b7 ' : ''}{periods} period{periods === 1 ? '' : 's'} scheduled{allocated ? ' \u00b7 ' + allocated + ' subject(s) allocated' : ''}
                      </span>
                      {c.batch !== batchForYear(state, c.year) && (
                        <button type="button" onClick={() => fixBatch(c)} className="ml-2 rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: T.warnTint, color: T.warn }}
                          title={'A ' + c.year + ' year class should have batch ' + batchForYear(state, c.year) + ' (from Academic year in Master Data \u2192 College)'}>
                          Set batch {batchForYear(state, c.year)}
                        </button>
                      )}
                    </div>
                    <button type="button" onClick={() => deleteClass(c)} className="rounded-md p-1 hover:bg-gray-100" title={'Delete ' + classLabel(state, c)}>
                      <Trash2 size={13} color={T.critical} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

const YEAR_OPTIONS = ['I', 'II', 'III', 'IV'];
const SECTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Batch (joining year - passing year) follows from the CLASS YEAR and the academic year set in
// Master Data -> College: I year joined this academic year, II year one year earlier, ...
// (Create Timetable used to default every class to 2024-2028 and semester 5, whatever the year.)
function batchForYear(state, year) {
  const parsed = parseInt(String(state.college?.academicYear || '').slice(0, 4), 10);
  const start = Number.isFinite(parsed) ? parsed : new Date().getFullYear();
  const yi = Math.max(0, YEAR_OPTIONS.indexOf(year));
  return (start - yi) + '\u2013' + (start - yi + 4);
}
function semesterForYear(year) { return Math.max(0, YEAR_OPTIONS.indexOf(year)) * 2 + 1; }

// "CSE III-A" only when that year really has more than one class. With a single class the
// section letter means nothing, so it is "CSE III year".
function classLabel(state, cs) {
  if (!cs) return '';
  const sameYear = state.classSections.filter((c) => c.departmentId === cs.departmentId && c.year === cs.year);
  return sameYear.length > 1 ? cs.departmentId + ' ' + cs.year + '-' + cs.section : cs.departmentId + ' ' + cs.year + ' year';
}

// Build the class_sections rows for a department: every chosen year x sections A..N.
// Rows that already exist (same department + year + section) are skipped, so this is
// safe to run again later to add "C" to a department that already has A and B.
function buildClassSections(state, departmentId, years, sectionCount) {
  const out = [];
  YEAR_OPTIONS.filter((y) => years.includes(y)).forEach((year) => {
    for (let i = 0; i < sectionCount; i++) {
      const section = SECTION_LETTERS[i];
      if (state.classSections.some((c) => c.departmentId === departmentId && c.year === year && c.section === section)) continue;
      out.push({ id: uid('CLS'), departmentId, batch: batchForYear(state, year), year, semester: semesterForYear(year), section, roomId: null });
    }
  });
  return out;
}

// Years + "how many sections" chooser. Ticking a letter means "A up to this one":
// tick C -> A, B, C. Tick the last selected letter again to drop it.
function ClassSectionPicker({ years, onYears, count, onCount }) {
  const chip = (on) => ({ borderColor: on ? T.primary : T.border, background: on ? T.primaryTint : 'transparent', color: on ? T.primary : T.ink });
  return (
    <div className="space-y-3">
      <div>
        <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>Years to create</span>
        <div className="flex flex-wrap gap-2">
          {YEAR_OPTIONS.map((y) => {
            const on = years.includes(y);
            return (
              <button key={y} type="button" onClick={() => onYears(on ? years.filter((x) => x !== y) : [...years, y])}
                className="rounded-full border px-3 py-1 text-xs font-medium" style={chip(on)}>
                {on ? '\u2713 ' : ''}{y} year
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>Sections {'\u2014'} tick up to the last one you need</span>
        <div className="flex flex-wrap gap-2">
          {SECTION_LETTERS.map((L, i) => {
            const on = i < count;
            return (
              <button key={L} type="button" onClick={() => onCount(i === count - 1 ? Math.max(1, i) : i + 1)}
                className="h-8 w-8 rounded-lg border text-sm font-semibold" style={chip(on)}>
                {L}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ClassPreview({ deptId, years, count, existing }) {
  const labels = [];
  YEAR_OPTIONS.filter((y) => years.includes(y)).forEach((y) => {
    for (let i = 0; i < count; i++) labels.push(deptId + ' ' + y + '-' + SECTION_LETTERS[i]);
  });
  if (labels.length === 0) return <p className="text-xs" style={{ color: T.warn }}>Pick at least one year.</p>;
  return (
    <p className="text-xs" style={{ color: T.muted }}>
      {labels.length - existing} new class(es) will be created{existing > 0 ? ' (' + existing + ' already exist and are kept)' : ''}: {labels.slice(0, 12).join(', ')}{labels.length > 12 ? ' \u2026 +' + (labels.length - 12) + ' more' : ''}
    </p>
  );
}

function DepartmentsTab({ state, actions, highlightId = null }) {
  const [form, setForm] = useState({ id: '', name: '' });
  const [divide, setDivide] = useState(false);
  const [years, setYears] = useState([...YEAR_OPTIONS]);
  const [count, setCount] = useState(2);

  // second card: add classes to a department that already exists (e.g. create CSE-B later)
  const [extraDept, setExtraDept] = useState(state.departments[0]?.id || '');
  const [extraYears, setExtraYears] = useState([...YEAR_OPTIONS]);
  const [extraCount, setExtraCount] = useState(2);
  const dept = extraDept || state.departments[0]?.id || '';

  const alreadyExisting = (deptId, ys, n) => YEAR_OPTIONS.filter((y) => ys.includes(y)).reduce((sum, y) => {
    for (let i = 0; i < n; i++) if (state.classSections.some((c) => c.departmentId === deptId && c.year === y && c.section === SECTION_LETTERS[i])) sum++;
    return sum;
  }, 0);

  function addDepartment() {
    const id = form.id.trim().toUpperCase().replace(/\s+/g, '-');
    const name = form.name.trim();
    if (!id || !name) { actions.toast('Fill in both the code and the name.', 'critical'); return; }
    if (state.departments.some((d) => d.id === id)) { actions.toast('A department with code ' + id + ' already exists.', 'critical'); return; }
    if (divide && years.length === 0) { actions.toast('Pick at least one year for the classes.', 'critical'); return; }
    const newSections = divide ? buildClassSections(state, id, years, count) : [];
    actions.persist(actions.logActivity(
      { ...state, departments: [...state.departments, { id, name }], classSections: [...state.classSections, ...newSections] },
      'Department added: ' + name + (newSections.length ? ' (+' + newSections.length + ' classes)' : ''),
      { entityType: 'department', entityId: id },
    ));
    setForm({ id: '', name: '' });
    actions.toast('Department added' + (newSections.length ? ' with ' + newSections.length + ' classes.' : '.'), 'success');
  }

  function addClassesToExisting() {
    if (!dept) return;
    if (extraYears.length === 0) { actions.toast('Pick at least one year.', 'critical'); return; }
    const newSections = buildClassSections(state, dept, extraYears, extraCount);
    if (newSections.length === 0) { actions.toast('Those classes already exist for ' + dept + '.', 'warn'); return; }
    actions.persist(actions.logActivity(
      { ...state, classSections: [...state.classSections, ...newSections] },
      'Classes created for ' + dept + ': ' + newSections.length,
      { entityType: 'department', entityId: dept },
    ));
    actions.toast(newSections.length + ' class(es) created for ' + dept + '.', 'success');
  }

  return (
    <div>
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {state.departments.map((d) => (
          <DepartmentCard key={d.id} d={d} state={state} actions={actions} highlightId={highlightId} />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Add department</p>
          <div className="flex gap-2">
            <Input placeholder="Code, e.g. CIVIL" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toUpperCase() })} className="w-32" />
            <Input placeholder="Department name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm" style={{ color: T.ink }}>
            <input type="checkbox" checked={divide} onChange={(e) => setDivide(e.target.checked)} />
            Divide into classes (year-wise sections A, B, C{'\u2026'})
          </label>

          {divide && (
            <div className="mt-3 rounded-lg border p-3" style={{ borderColor: T.border, background: T.bg }}>
              <ClassSectionPicker years={years} onYears={setYears} count={count} onCount={setCount} />
              <div className="mt-3">
                <ClassPreview deptId={form.id.trim().toUpperCase() || 'DEPT'} years={years} count={count} existing={0} />
              </div>
            </div>
          )}

          <div className="mt-3">
            <PrimaryButton icon={Plus} onClick={addDepartment}>{divide ? 'Add department & create classes' : 'Add'}</PrimaryButton>
          </div>
        </Card>

        <Card className="p-4">
          <p className="ts-display mb-1 text-sm font-semibold" style={{ color: T.ink }}>Add classes to an existing department</p>
          <p className="mb-3 text-xs" style={{ color: T.muted }}>For example create section B or C later. Classes that already exist are never duplicated.</p>
          <Field label="Department">
            <Select value={dept} onChange={(e) => setExtraDept(e.target.value)}>
              {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
            </Select>
          </Field>
          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: T.border, background: T.bg }}>
            <ClassSectionPicker years={extraYears} onYears={setExtraYears} count={extraCount} onCount={setExtraCount} />
            <div className="mt-3">
              <ClassPreview deptId={dept} years={extraYears} count={extraCount} existing={alreadyExisting(dept, extraYears, extraCount)} />
            </div>
          </div>
          <div className="mt-3">
            <PrimaryButton icon={Plus} onClick={addClassesToExisting} disabled={!dept}>Create classes</PrimaryButton>
          </div>
        </Card>
      </div>
    </div>
  );
}

function FacultyTab({ state, actions, onAdd }) {
  const [editingFaculty, setEditingFaculty] = useState(null);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [designationFilter, setDesignationFilter] = useState('ALL');

  const filtered = state.faculty.filter((f) =>
    (deptFilter === 'ALL' || f.departmentId === deptFilter) &&
    (designationFilter === 'ALL' || f.designation === designationFilter) &&
    (f.name.toLowerCase().includes(search.toLowerCase()) || f.id.toLowerCase().includes(search.toLowerCase()))
  );
  const filtersActive = search || deptFilter !== 'ALL' || designationFilter !== 'ALL';

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm" style={{ color: T.muted }}>
          {filtersActive ? filtered.length + ' of ' + state.faculty.length : state.faculty.length} faculty members across {state.departments.length} departments.
        </p>
        <PrimaryButton icon={Plus} onClick={onAdd}>Add faculty</PrimaryButton>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" color={T.muted} />
          <Input placeholder="Search name or ID" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48 pl-8" />
        </div>
        <Select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="w-36">
          <option value="ALL">All departments</option>
          {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
        </Select>
        <Select value={designationFilter} onChange={(e) => setDesignationFilter(e.target.value)} className="w-44">
          <option value="ALL">All designations</option>
          {['Professor', 'Associate Professor', 'Assistant Professor'].map((d) => <option key={d} value={d}>{d}</option>)}
        </Select>
        {filtersActive && (
          <GhostButton onClick={() => { setSearch(''); setDeptFilter('ALL'); setDesignationFilter('ALL'); }}>Clear filters</GhostButton>
        )}
      </div>

      {state.faculty.length === 0 ? (
        <EmptyState icon={Users} title="No faculty members found." subtitle="Add faculty to begin building your academic master data." actionLabel="Add faculty" onAction={onAdd} />
      ) : filtered.length === 0 ? (
        <EmptyState icon={Users} title="No faculty match these filters." subtitle="Try a different search term or clear the filters." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: T.bg }}>
                {['ID', 'Name', 'Department', 'Designation', 'Weekly load', ''].map((h) => (
                  <th key={h} className="whitespace-nowrap px-4 py-2.5 text-left font-semibold" style={{ color: T.muted }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => {
                const load = state.subjects.filter((s) => s.facultyIds.includes(f.id)).reduce((sum, s) => sum + s.weeklyHours, 0);
                return (
                  <tr key={f.id} className="border-t" style={{ borderColor: T.border }}>
                    <td className="ts-mono px-4 py-2.5" style={{ color: T.muted }}>{f.id}</td>
                    <td className="px-4 py-2.5 font-medium" style={{ color: T.ink }}>{f.name}</td>
                    <td className="px-4 py-2.5"><Badge>{f.departmentId}</Badge></td>
                    <td className="px-4 py-2.5" style={{ color: T.ink }}>{f.designation}</td>
                    <td className="px-4 py-2.5" style={{ color: T.ink }}>{load} / {f.maxWeeklyHours}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => setEditingFaculty(f)} className="rounded-md p-1.5 hover:bg-gray-100" title="Edit faculty">
                        <Pencil size={14} color={T.primary} />
                      </button>
                      <button
                        onClick={() => {
                          // Same dependency protection Departments already has - without this,
                          // deleting a faculty who still has timetable slots assigned leaves
                          // those entries pointing at a facultyId that no longer exists, and
                          // the grid just silently shows a blank faculty line (subject + room
                          // only) with no explanation.
                          const assignedCount = state.timetableEntries.filter((e) => e.facultyId === f.id).length;
                          if (assignedCount > 0) {
                            actions.toast('Can\u2019t delete ' + f.name + ' \u2014 they\u2019re still assigned to ' + assignedCount + ' timetable slot(s). Clear or reassign those in Create Timetable first.', 'critical');
                            return;
                          }
                          // Scrub this faculty's id out of every subject.facultyIds too -
                          // otherwise a subject that listed them keeps a dangling reference
                          // and the same "name silently disappears" symptom the timetable
                          // grid had before shows up in the Subjects table's Faculty column.
                          const nextSubjects = state.subjects.some((s) => (s.facultyIds || []).includes(f.id))
                            ? state.subjects.map((s) => ((s.facultyIds || []).includes(f.id) ? { ...s, facultyIds: s.facultyIds.filter((id) => id !== f.id) } : s))
                            : state.subjects;
                          actions.persist(actions.logActivity({ ...state, faculty: state.faculty.filter((x) => x.id !== f.id), subjects: nextSubjects, classAssignments: (state.classAssignments || []).filter((a) => a.facultyId !== f.id) }, 'Faculty removed: ' + f.name));
                          actions.toast('Faculty removed.');
                        }}
                        className="rounded-md p-1.5 hover:bg-gray-100"
                        title="Delete faculty"
                      >
                        <Trash2 size={14} color={T.critical} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {editingFaculty && <AddFacultyModal state={state} actions={actions} editing={editingFaculty} onClose={() => setEditingFaculty(null)} />}
    </div>
  );
}

function SubjectRow({ s, state, actions, highlightId, onEdit }) {
  const [flashing, ref] = useFlashHighlight(highlightId, s.id);
  return (
    <tr ref={ref} className="border-t" style={{ borderColor: T.border, background: flashing ? T.primaryTint : 'transparent', boxShadow: flashing ? `inset 0 0 0 1px ${T.primary}` : 'none' }}>
      <td className="ts-mono px-4 py-2.5" style={{ color: T.muted }}>{s.code}</td>
      <td className="px-4 py-2.5 font-medium" style={{ color: T.ink }}>{s.name}</td>
      <td className="px-4 py-2.5">
        <div className="flex flex-wrap gap-1">
          {(s.departmentIds || []).map((did) => <Badge key={did}>{did}</Badge>)}
        </div>
      </td>
      <td className="px-4 py-2.5" style={{ color: T.ink }}>{s.year}</td>
      <td className="px-4 py-2.5" style={{ color: T.ink }}>{s.type}</td>
      <td className="px-4 py-2.5" style={{ color: T.ink }}>{state.faculty.filter((f) => s.facultyIds.includes(f.id)).map((f) => f.name).join(', ') || '\u2014'}</td>
      <td className="px-4 py-2.5" style={{ color: T.ink }}>{s.weeklyHours}</td>
      <td className="px-4 py-2.5 text-right">
        <button onClick={() => onEdit(s)} className="rounded-md p-1.5 hover:bg-gray-100" title="Edit subject">
          <Pencil size={14} color={T.primary} />
        </button>
        <button
          onClick={() => {
            // Faculty deletion was already blocked while they had timetable slots; subjects were
            // not - deleting one left blank "ghost" periods in every class that used it (subject
            // + faculty vanish, the cell stays occupied). Same guard here.
            const usedSlots = state.timetableEntries.filter((e) => e.subjectId === s.id).length;
            if (usedSlots > 0) {
              actions.toast('Can\u2019t delete ' + s.name + ' \u2014 it is still used in ' + usedSlots + ' timetable period(s). Clear those in Create Timetable first.', 'critical');
              return;
            }
            // Same dangling-reference cleanup as the faculty-delete side: strip this
            // subject's id out of every faculty.subjectIds so nobody's "Subjects handled"
            // list keeps pointing at a subject that no longer exists.
            const nextFaculty = state.faculty.some((f) => (f.subjectIds || []).includes(s.id))
              ? state.faculty.map((f) => ((f.subjectIds || []).includes(s.id) ? { ...f, subjectIds: f.subjectIds.filter((id) => id !== s.id) } : f))
              : state.faculty;
            actions.persist(actions.logActivity({ ...state, subjects: state.subjects.filter((x) => x.id !== s.id), faculty: nextFaculty, classAssignments: (state.classAssignments || []).filter((a) => a.subjectId !== s.id) }, 'Subject removed: ' + s.name));
            actions.toast('Subject removed.');
          }}
          className="rounded-md p-1.5 hover:bg-gray-100"
          title="Delete subject"
        >
          <Trash2 size={14} color={T.critical} />
        </button>
      </td>
    </tr>
  );
}

const EMPTY_SUBJECT_FORM = (state) => ({
  code: '', name: '', departmentIds: state.departments[0]?.id ? [state.departments[0].id] : [],
  year: 'III', semester: 5, type: 'Theory', weeklyHours: 4, facultyIds: [],
});

function SubjectsTab({ state, actions, highlightId = null }) {
  const [form, setForm] = useState(() => EMPTY_SUBJECT_FORM(state));
  // Non-null while editing an existing subject instead of creating a new one -
  // the same form below is reused for both, just its submit target changes.
  const [editingId, setEditingId] = useState(null);
  const formCardRef = React.useRef(null);

  function startEdit(s) {
    // eslint-disable-next-line no-unused-vars
    const { id, labRequired, ...rest } = s;
    setForm({ ...rest, departmentIds: s.departmentIds || [], facultyIds: s.facultyIds || [] });
    setEditingId(s.id);
    formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_SUBJECT_FORM(state));
  }

  // A subject can now belong to more than one department at once (e.g. a common
  // "Mathematics II" paper taught to II-year CSE, AIDS and IT alike) - this is the
  // same year/semester subject, just shared, not one row per department.
  const eligibleFaculty = state.faculty.filter((f) => form.departmentIds.includes(f.departmentId));

  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [yearFilter, setYearFilter] = useState('ALL');
  const [typeFilter, setTypeFilter] = useState('ALL');

  const filteredSubjects = state.subjects.filter((s) =>
    (deptFilter === 'ALL' || (s.departmentIds || []).includes(deptFilter)) &&
    (yearFilter === 'ALL' || s.year === yearFilter) &&
    (typeFilter === 'ALL' || s.type === typeFilter) &&
    (s.name.toLowerCase().includes(search.toLowerCase()) || s.code.toLowerCase().includes(search.toLowerCase()))
  );
  const subjectFiltersActive = search || deptFilter !== 'ALL' || yearFilter !== 'ALL' || typeFilter !== 'ALL';

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" color={T.muted} />
          <Input placeholder="Search code or name" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48 pl-8" />
        </div>
        <Select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} className="w-36">
          <option value="ALL">All departments</option>
          {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
        </Select>
        <Select value={yearFilter} onChange={(e) => setYearFilter(e.target.value)} className="w-28">
          <option value="ALL">All years</option>
          {['I', 'II', 'III', 'IV'].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="w-32">
          <option value="ALL">All types</option>
          <option value="Theory">Theory</option>
          <option value="Lab">Lab</option>
        </Select>
        {subjectFiltersActive && (
          <GhostButton onClick={() => { setSearch(''); setDeptFilter('ALL'); setYearFilter('ALL'); setTypeFilter('ALL'); }}>Clear filters</GhostButton>
        )}
        <span className="text-xs" style={{ color: T.muted }}>
          {subjectFiltersActive ? filteredSubjects.length + ' of ' + state.subjects.length : state.subjects.length} subjects
        </span>
      </div>

      {state.subjects.length > 0 && filteredSubjects.length === 0 ? (
        <EmptyState icon={BookOpen} title="No subjects match these filters." subtitle="Try a different search term or clear the filters." />
      ) : (
        <Card className="mb-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: T.bg }}>
                {['Code', 'Name', 'Department(s)', 'Year', 'Type', 'Faculty', 'Hours', ''].map((h) => (
                  <th key={h || 'actions'} className="whitespace-nowrap px-4 py-2.5 text-left font-semibold" style={{ color: T.muted }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredSubjects.map((s) => (
                <SubjectRow key={s.id} s={s} state={state} actions={actions} highlightId={highlightId} onEdit={startEdit} />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card ref={formCardRef} className="max-w-2xl p-4" style={editingId ? { boxShadow: `0 0 0 2px ${T.primary}` } : {}}>
        <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>{editingId ? 'Edit subject' : 'Add subject'}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Subject code"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          <Field label="Subject name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Year">
            <Select value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })}>
              {['I', 'II', 'III', 'IV'].map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="Theory">Theory</option>
              <option value="Lab">Lab</option>
            </Select>
          </Field>
          <Field label="Weekly hours"><Input type="number" value={form.weeklyHours} onChange={(e) => setForm({ ...form, weeklyHours: Number(e.target.value) })} /></Field>
        </div>
        <div className="mt-3">
          <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>
            Department(s) — pick every department that offers this subject in this year
          </span>
          <div className="flex flex-wrap gap-2">
            {state.departments.map((d) => {
              const checked = form.departmentIds.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setForm({
                    ...form,
                    departmentIds: checked ? form.departmentIds.filter((x) => x !== d.id) : [...form.departmentIds, d.id],
                    // Drop faculty picks that belong to a department we just unchecked.
                    facultyIds: form.facultyIds.filter((fid) => {
                      const fac = state.faculty.find((f) => f.id === fid);
                      const nextDeptIds = checked ? form.departmentIds.filter((x) => x !== d.id) : [...form.departmentIds, d.id];
                      return fac && nextDeptIds.includes(fac.departmentId);
                    }),
                  })}
                  className="rounded-full border px-3 py-1 text-xs font-medium"
                  style={{ borderColor: checked ? T.primary : T.border, background: checked ? T.primaryTint : 'transparent', color: checked ? T.primary : T.ink }}
                >
                  {d.id}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-3">
          <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>Faculty who can teach this</span>
          <div className="flex flex-wrap gap-2">
            {eligibleFaculty.map((f) => {
              const checked = form.facultyIds.includes(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setForm({ ...form, facultyIds: checked ? form.facultyIds.filter((x) => x !== f.id) : [...form.facultyIds, f.id] })}
                  className="rounded-full border px-3 py-1 text-xs font-medium"
                  style={{ borderColor: checked ? T.primary : T.border, background: checked ? T.primaryTint : 'transparent', color: checked ? T.primary : T.ink }}
                >
                  {f.name} <span style={{ color: T.muted }}>({f.departmentId})</span>
                </button>
              );
            })}
            {form.departmentIds.length === 0 && <p className="text-xs" style={{ color: T.muted }}>Pick at least one department first.</p>}
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <PrimaryButton
            icon={editingId ? undefined : Plus}
            onClick={() => {
              if (!form.code || !form.name) { actions.toast('Enter a subject code and name.', 'critical'); return; }
              if (form.departmentIds.length === 0) { actions.toast('Choose at least one department.', 'critical'); return; }
              if (editingId) {
                // Same facultyIds <-> subjectIds mirroring as the faculty side (see
                // AddFacultyModal.submit) - keep both directions of the relationship
                // in sync in one save instead of only writing this subject's side.
                const prevSubject = state.subjects.find((x) => x.id === editingId);
                const prevFacultyIds = prevSubject?.facultyIds || [];
                const nextFacultyIds = form.facultyIds || [];
                const added = nextFacultyIds.filter((id) => !prevFacultyIds.includes(id));
                const removed = prevFacultyIds.filter((id) => !nextFacultyIds.includes(id));
                const nextFaculty = (added.length || removed.length)
                  ? state.faculty.map((f) => {
                      if (added.includes(f.id)) return f.subjectIds.includes(editingId) ? f : { ...f, subjectIds: [...f.subjectIds, editingId] };
                      if (removed.includes(f.id)) return { ...f, subjectIds: f.subjectIds.filter((sid) => sid !== editingId) };
                      return f;
                    })
                  : state.faculty;
                const nextSubjects = state.subjects.map((s) => (s.id === editingId ? { ...s, ...form, labRequired: form.type === 'Lab' } : s));
                actions.persist(actions.logActivity({ ...state, subjects: nextSubjects, faculty: nextFaculty }, 'Subject updated: ' + form.name));
                actions.toast('Subject updated.');
                cancelEdit();
              } else {
                const newId = uid('SUB');
                const facultyIds = form.facultyIds || [];
                const nextFaculty = facultyIds.length
                  ? state.faculty.map((f) => (facultyIds.includes(f.id) ? { ...f, subjectIds: f.subjectIds.includes(newId) ? f.subjectIds : [...f.subjectIds, newId] } : f))
                  : state.faculty;
                const newSubject = { id: newId, labRequired: form.type === 'Lab', ...form };
                actions.persist(actions.logActivity({ ...state, subjects: [...state.subjects, newSubject], faculty: nextFaculty }, 'Subject added: ' + form.name));
                setForm(EMPTY_SUBJECT_FORM(state));
                actions.toast('Subject added.');
              }
            }}
          >
            {editingId ? 'Save changes' : 'Add subject'}
          </PrimaryButton>
          {editingId && <GhostButton onClick={cancelEdit}>Cancel edit</GhostButton>}
        </div>
      </Card>
    </div>
  );
}

function RoomRow({ r, icon: Icon, deleteKey, actions, highlightId }) {
  const [flashing, ref] = useFlashHighlight(highlightId, r.id);
  // Location/Block only applies to labs (labs.location) - classrooms never show it,
  // per Master Data \u2192 Classrooms & Labs staying capacity/department only.
  const isLab = deleteKey === 'labs';
  return (
    <div ref={ref} className="flex items-center justify-between px-4 py-3 text-sm" style={{ borderColor: T.border, background: flashing ? T.primaryTint : 'transparent' }}>
      <div className="flex items-center gap-2.5">
        <Icon size={15} color={T.primary} />
        <div>
          <p className="font-medium" style={{ color: T.ink }}>{r.name}</p>
          <p className="text-xs" style={{ color: T.muted }}>
            {r.departmentId} {'\u00b7'} Capacity {r.capacity}
            {isLab && <> {'\u00b7'} {r.location ? r.location : 'Not Assigned'}</>}
          </p>
        </div>
      </div>
      <button onClick={() => actions.deleteRecord(deleteKey, r.id, (deleteKey === 'labs' ? 'Lab' : 'Classroom') + ' removed: ' + r.name)} className="rounded-md p-1.5 hover:bg-gray-100"><Trash2 size={14} color={T.critical} /></button>
    </div>
  );
}

function RoomsTab({ state, actions, highlightId = null }) {
  const [roomForm, setRoomForm] = useState({ name: '', capacity: 60, departmentId: state.departments[0]?.id || '' });
  const [labForm, setLabForm] = useState({ name: '', capacity: 30, departmentId: state.departments[0]?.id || '', location: '' });
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div>
        <p className="ts-display mb-2 text-sm font-semibold" style={{ color: T.ink }}>Classrooms</p>
        <Card className="mb-3 divide-y" style={{ borderColor: T.border }}>
          {state.classrooms.map((r) => (
            <RoomRow key={r.id} r={r} icon={DoorClosed} deleteKey="classrooms" actions={actions} highlightId={highlightId} />
          ))}
        </Card>
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Room name"><Input placeholder="CFF04" value={roomForm.name} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} className="w-32" /></Field>
            <Field label="Capacity"><Input type="number" value={roomForm.capacity} onChange={(e) => setRoomForm({ ...roomForm, capacity: Number(e.target.value) })} className="w-24" /></Field>
            <Field label="Department">
              <Select value={roomForm.departmentId} onChange={(e) => setRoomForm({ ...roomForm, departmentId: e.target.value })} className="w-28">
                {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
              </Select>
            </Field>
            <PrimaryButton icon={Plus} onClick={() => {
              if (!roomForm.name) { actions.toast('Enter a room name.', 'critical'); return; }
              actions.addRecord('classrooms', { id: uid('ROOM'), type: 'classroom', ...roomForm }, 'Classroom added: ' + roomForm.name);
              setRoomForm({ name: '', capacity: 60, departmentId: state.departments[0]?.id || '' });
              actions.toast('Classroom added.');
            }}>Add</PrimaryButton>
          </div>
        </Card>
      </div>

      <div>
        <p className="ts-display mb-2 text-sm font-semibold" style={{ color: T.ink }}>Labs</p>
        <Card className="mb-3 divide-y" style={{ borderColor: T.border }}>
          {state.labs.map((r) => (
            <RoomRow key={r.id} r={r} icon={FlaskConical} deleteKey="labs" actions={actions} highlightId={highlightId} />
          ))}
        </Card>
        <Card className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Lab name"><Input placeholder="Networks Lab" value={labForm.name} onChange={(e) => setLabForm({ ...labForm, name: e.target.value })} className="w-36" /></Field>
            <Field label="Location/Block"><Input placeholder="A Block" value={labForm.location} onChange={(e) => setLabForm({ ...labForm, location: e.target.value })} className="w-28" /></Field>
            <Field label="Capacity"><Input type="number" value={labForm.capacity} onChange={(e) => setLabForm({ ...labForm, capacity: Number(e.target.value) })} className="w-24" /></Field>
            <Field label="Department">
              <Select value={labForm.departmentId} onChange={(e) => setLabForm({ ...labForm, departmentId: e.target.value })} className="w-28">
                {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
              </Select>
            </Field>
            <PrimaryButton icon={Plus} onClick={() => {
              if (!labForm.name) { actions.toast('Enter a lab name.', 'critical'); return; }
              actions.addRecord('labs', { id: uid('LAB'), type: 'lab', ...labForm, location: labForm.location || null }, 'Lab added: ' + labForm.name);
              setLabForm({ name: '', capacity: 30, departmentId: state.departments[0]?.id || '', location: '' });
              actions.toast('Lab added.');
            }}>Add</PrimaryButton>
          </div>
        </Card>
      </div>
    </div>
  );
}

// Old code used `state.faculty.length + 1`, so after deleting any faculty the next new
// one got an id that already existed -> duplicate primary key -> the insert failed and
// was rolled back ("can't add / edit faculty"). Also it always used the FIRST department
// instead of the selected one. Pick the first unused number for the chosen department.
function nextFacultyId(state, deptId) {
  const used = new Set(state.faculty.map((f) => f.id));
  let n = state.faculty.filter((f) => f.departmentId === deptId).length + 1;
  let id;
  do { id = 'FAC-' + deptId + '-' + String(n++).padStart(3, '0'); } while (used.has(id));
  return id;
}

function AddFacultyModal({ state, actions, onClose, editing = null }) {
  const [showAllSubjects, setShowAllSubjects] = useState(false);
  // "CSE-III-A takes Data Structures with this teacher, CSE-III-B does not" - kept as
  // section|subject keys, saved into state.classAssignments on submit.
  const [classPicks, setClassPicks] = useState(() => new Set(
    (state.classAssignments || []).filter((a) => editing && a.facultyId === editing.id).map((a) => a.classSectionId + '|' + a.subjectId),
  ));
  const [form, setForm] = useState(() => editing ? { ...editing } : {
    id: nextFacultyId(state, state.departments[0]?.id || 'GEN'),
    name: '', departmentId: state.departments[0]?.id || '', designation: 'Assistant Professor',
    email: '', phone: '', subjectIds: [], maxWeeklyHours: 20, availability: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  });
  const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  // Real colleges have faculty teaching another department's / a common subject. The picker
  // used to list ONLY the faculty's own department, so those links could never be made (or
  // removed) from here. Own-department subjects + anything already selected are always shown;
  // the toggle reveals every other subject.
  const visibleSubjects = state.subjects.filter((s) =>
    showAllSubjects || (s.departmentIds || []).includes(form.departmentId) || (form.subjectIds || []).includes(s.id));

  function submit() {
    if (!form.name || !form.email) { actions.toast('Enter a name and email.', 'critical'); return; }

    // subject.facultyIds and faculty.subjectIds describe the same relationship from
    // opposite ends and were drifting apart - checking a subject here only ever wrote
    // faculty.subjectIds, so the Subjects table (which reads subject.facultyIds) never
    // saw it. Whenever the picks here change, mirror the diff onto every affected
    // subject's facultyIds in the same save, so both sides always agree.
    const facultyId = editing ? editing.id : form.id;
    const prevSubjectIds = editing?.subjectIds || [];
    const nextSubjectIds = form.subjectIds || [];
    const added = nextSubjectIds.filter((id) => !prevSubjectIds.includes(id));
    const removed = prevSubjectIds.filter((id) => !nextSubjectIds.includes(id));
    const nextSubjects = (added.length || removed.length)
      ? state.subjects.map((s) => {
          if (added.includes(s.id)) return s.facultyIds.includes(facultyId) ? s : { ...s, facultyIds: [...s.facultyIds, facultyId] };
          if (removed.includes(s.id)) return { ...s, facultyIds: s.facultyIds.filter((fid) => fid !== facultyId) };
          return s;
        })
      : state.subjects;

    const nextFaculty = editing
      ? state.faculty.map((f) => (f.id === editing.id ? { ...f, ...form } : f))
      : [...state.faculty, form];
    const activityText = editing ? 'Faculty updated: ' + form.name : 'New faculty added: ' + form.name;

    // Class allocations: drop this teacher's old picks, (re)write the chosen ones. A
    // section+subject has exactly one teacher, so picking it here replaces whoever had it.
    const oldAssignments = state.classAssignments || [];
    const chosen = new Set([...classPicks].filter((k) => nextSubjectIds.includes(k.split('|')[1])));
    const kept = oldAssignments.filter((a) => !chosen.has(a.classSectionId + '|' + a.subjectId) && a.facultyId !== facultyId);
    const written = [...chosen].map((k) => {
      const [classSectionId, subjectId] = k.split('|');
      const existing = oldAssignments.find((a) => a.classSectionId === classSectionId && a.subjectId === subjectId);
      return { id: existing?.id || 'CA-' + classSectionId + '-' + subjectId, classSectionId, subjectId, facultyId, weeklyHours: existing?.weeklyHours ?? null };
    });
    const nextAssignments = [...kept, ...written];

    actions.persist(actions.logActivity({ ...state, faculty: nextFaculty, subjects: nextSubjects, classAssignments: nextAssignments }, activityText));
    actions.toast(editing ? 'Faculty updated.' : 'Faculty added successfully.');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={editing ? 'Edit faculty' : 'Add faculty'}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Faculty ID">
          {editing ? (
            <p className="ts-mono rounded-lg border px-3 py-2 text-sm" style={{ borderColor: T.border, color: T.muted, background: T.bg }}>{form.id}</p>
          ) : (
            <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          )}
        </Field>
        <Field label="Faculty name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Dr. Arun Kumar" /></Field>
        <Field label="Department">
          <Select value={form.departmentId} onChange={(e) => setForm(editing ? { ...form, departmentId: e.target.value } : { ...form, departmentId: e.target.value, id: nextFacultyId(state, e.target.value) })}>
            {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
          </Select>
        </Field>
        <Field label="Designation">
          <Select value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })}>
            {['Professor', 'Associate Professor', 'Assistant Professor'].map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </Field>
        <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@sinct.edu" /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="9840012345" /></Field>
        <Field label="Maximum weekly hours"><Input type="number" value={form.maxWeeklyHours} onChange={(e) => setForm({ ...form, maxWeeklyHours: Number(e.target.value) })} /></Field>
      </div>

      <div className="mt-3">
        <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>Subjects</span>
        <div className="flex flex-wrap gap-2">
          {visibleSubjects.map((s) => {
            const checked = form.subjectIds.includes(s.id);
            return (
              <button
                key={s.id}
                onClick={() => setForm({ ...form, subjectIds: checked ? form.subjectIds.filter((x) => x !== s.id) : [...form.subjectIds, s.id] })}
                className="rounded-full border px-3 py-1 text-xs font-medium"
                style={{ borderColor: checked ? T.primary : T.border, background: checked ? T.primaryTint : 'transparent', color: checked ? T.primary : T.ink }}
              >
                {s.name}{(s.departmentIds || []).includes(form.departmentId) ? '' : ' (' + (s.departmentIds || []).join('/') + ')'}
              </button>
            );
          })}
          {visibleSubjects.length === 0 && <p className="text-xs" style={{ color: T.muted }}>No subjects yet for this department.</p>}
          <button type="button" onClick={() => setShowAllSubjects((v) => !v)} className="rounded-full border px-3 py-1 text-xs font-medium" style={{ borderColor: T.border, color: T.muted }}>
            {showAllSubjects ? 'Only this department' : 'Show other departments\u2019 subjects'}
          </button>
        </div>
      </div>

      {(form.subjectIds || []).length > 0 && state.classSections.length > 0 && (
        <div className="mt-3">
          <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>Which classes take this teacher? (per subject)</span>
          <div className="space-y-2">
            {(form.subjectIds || []).map((sid) => {
              const s = state.subjects.find((x) => x.id === sid);
              if (!s) return null;
              const sections = state.classSections.filter((c) => (s.departmentIds || []).includes(c.departmentId) && (!s.year || c.year === s.year));
              if (!sections.length) return null;
              const me = editing ? editing.id : form.id;
              return (
                <div key={sid} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium" style={{ color: T.ink }}>{s.name}:</span>
                  {sections.map((c) => {
                    const key = c.id + '|' + sid;
                    const on = classPicks.has(key);
                    const other = (state.classAssignments || []).find((a) => a.classSectionId === c.id && a.subjectId === sid && a.facultyId && a.facultyId !== me);
                    const otherName = other ? state.faculty.find((f) => f.id === other.facultyId)?.name : '';
                    return (
                      <button
                        key={key}
                        type="button"
                        title={other && !on ? 'Currently taught by ' + otherName + ' \u2014 selecting replaces them' : ''}
                        onClick={() => setClassPicks((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
                        className="rounded-full border px-2.5 py-0.5 text-xs font-medium"
                        style={{ borderColor: on ? T.primary : T.border, background: on ? T.primaryTint : 'transparent', color: on ? T.primary : T.ink }}
                      >
                        {classLabel(state, c)}{other && !on ? ' (' + otherName + ')' : ''}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <p className="mt-1 text-xs" style={{ color: T.muted }}>Leave a class unselected to keep the old rule: any eligible teacher of the subject may be used.</p>
        </div>
      )}

      <div className="mt-3">
        <span className="mb-1 block text-xs font-semibold" style={{ color: T.muted }}>Availability</span>
        <div className="flex flex-wrap gap-2">
          {weekdays.map((w) => {
            const checked = form.availability.includes(w);
            return (
              <button
                key={w}
                onClick={() => setForm({ ...form, availability: checked ? form.availability.filter((x) => x !== w) : [...form.availability, w] })}
                className="rounded-full border px-3 py-1 text-xs font-medium"
                style={{ borderColor: checked ? T.success : T.border, background: checked ? T.successTint : 'transparent', color: checked ? T.success : T.ink }}
              >
                {w}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 flex gap-2">
        <PrimaryButton onClick={submit}>{editing ? 'Save changes' : 'Add faculty'}</PrimaryButton>
        <GhostButton onClick={onClose}>Cancel</GhostButton>
      </div>
    </Modal>
  );
}

function FacultyDetails({ state, actions, conflicts, globalFacultyId, setGlobalFacultyId, deptFilter, setDeptFilter }) {
  const [search, setSearch] = useState('');
  const [designationFilter, setDesignationFilter] = useState('ALL');
  const tabs = ['ALL', ...state.departments.map((d) => d.id)];

  const filtered = state.faculty.filter((f) =>
    (deptFilter === 'ALL' || f.departmentId === deptFilter) &&
    (designationFilter === 'ALL' || f.designation === designationFilter) &&
    f.name.toLowerCase().includes(search.toLowerCase())
  );

  const selected = state.faculty.find((f) => f.id === globalFacultyId);

  return (
    <div>
      <p className="mb-4 text-sm" style={{ color: T.muted }}>Manage faculty centrally and reuse them across every timetable.</p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" color={T.muted} />
          <Input placeholder="Search faculty" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48 pl-8" />
        </div>
        <Select value={designationFilter} onChange={(e) => setDesignationFilter(e.target.value)} className="w-44">
          <option value="ALL">All designations</option>
          {['Professor', 'Associate Professor', 'Assistant Professor'].map((d) => <option key={d} value={d}>{d}</option>)}
        </Select>
        <div className="ml-auto">
          <PrimaryButton icon={Plus} onClick={() => actions.setFacultyModalOpen(true)}>Add faculty</PrimaryButton>
        </div>
      </div>

      <div className="mb-5 flex gap-1 overflow-x-auto rounded-lg p-1" style={{ background: '#EEF1F4' }}>
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setDeptFilter(t)}
            className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
            style={{ background: deptFilter === t ? T.surface : 'transparent', color: deptFilter === t ? T.primary : T.muted }}
          >
            {t}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Users} title="No faculty members found." subtitle="Add faculty to begin building your academic master data." actionLabel="Add faculty" onAction={() => actions.setFacultyModalOpen(true)} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((f) => {
            const primarySubject = state.subjects.find((s) => f.subjectIds.includes(s.id));
            return (
              <Card key={f.id} className="cursor-pointer p-4 transition-shadow hover:shadow-md" onClick={() => setGlobalFacultyId(f.id)}>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-bold" style={{ background: T.primaryTint, color: T.primary }}>
                    {f.name.split(' ').slice(-1)[0][0]}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold" style={{ color: T.ink }}>{f.name}</p>
                    <p className="text-xs" style={{ color: T.muted }}>{f.designation}</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <Badge>{f.departmentId}</Badge>
                  <span className="text-xs" style={{ color: T.muted }}>{primarySubject ? primarySubject.name : 'No subject'}</span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {selected && (
        <Drawer open onClose={() => setGlobalFacultyId(null)} title="Faculty profile">
          <FacultyProfile faculty={selected} state={state} conflicts={conflicts} />
        </Drawer>
      )}
    </div>
  );
}

function FacultyProfile({ faculty, state, conflicts }) {
  const subjects = state.subjects.filter((s) => faculty.subjectIds.includes(s.id));
  const load = state.subjects.filter((s) => s.facultyIds.includes(faculty.id)).reduce((sum, s) => sum + s.weeklyHours, 0);
  const entries = state.timetableEntries.filter((e) => e.facultyId === faculty.id);
  const hasConflict = conflicts.some((c) => c.facultyId === faculty.id);

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-full text-lg font-bold" style={{ background: T.primaryTint, color: T.primary }}>
          {faculty.name.split(' ').slice(-1)[0][0]}
        </div>
        <div>
          <p className="ts-display text-base font-semibold" style={{ color: T.ink }}>{faculty.name}</p>
          <p className="ts-mono text-xs" style={{ color: T.muted }}>{faculty.id}</p>
          {hasConflict && <div className="mt-1"><Badge tone="critical">Scheduling conflict</Badge></div>}
        </div>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 text-sm">
        <div><p className="text-xs" style={{ color: T.muted }}>Department</p><p className="font-medium" style={{ color: T.ink }}>{faculty.departmentId}</p></div>
        <div><p className="text-xs" style={{ color: T.muted }}>Designation</p><p className="font-medium" style={{ color: T.ink }}>{faculty.designation}</p></div>
        <div className="flex items-center gap-1.5"><Mail size={13} color={T.muted} /><p style={{ color: T.ink }}>{faculty.email}</p></div>
        <div className="flex items-center gap-1.5"><Phone size={13} color={T.muted} /><p style={{ color: T.ink }}>{faculty.phone}</p></div>
      </div>

      <p className="mb-1.5 text-xs font-semibold" style={{ color: T.muted }}>Subjects handled</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {subjects.length ? subjects.map((s) => <Badge key={s.id}>{s.name}</Badge>) : <span className="text-sm" style={{ color: T.muted }}>None assigned yet.</span>}
      </div>

      <p className="mb-1.5 text-xs font-semibold" style={{ color: T.muted }}>Weekly load</p>
      <p className="mb-1 text-sm font-medium" style={{ color: T.ink }}>{load} / {faculty.maxWeeklyHours} periods</p>
      <ProgressBar value={load} max={faculty.maxWeeklyHours} color={load > faculty.maxWeeklyHours ? T.critical : T.primary} />

      <p className="mb-1.5 mt-4 text-xs font-semibold" style={{ color: T.muted }}>Availability</p>
      <div className="flex flex-wrap gap-1.5">
        {faculty.availability.map((a) => <Badge key={a} tone="success">{a}</Badge>)}
      </div>

      <p className="mb-2 mt-5 text-xs font-semibold" style={{ color: T.muted }}>Current timetable</p>
      <div className="space-y-2">
        {entries.length === 0 && <p className="text-sm" style={{ color: T.muted }}>No classes scheduled yet.</p>}
        {entries.map((e) => {
          const d = state.dayOrders.find((x) => x.id === e.dayOrderId);
          const p = state.periods.find((x) => x.id === e.periodId);
          const s = state.subjects.find((x) => x.id === e.subjectId);
          const c = state.classSections.find((x) => x.id === e.classSectionId);
          const isConflicted = conflicts.some((cf) => cf.entryA.id === e.id || cf.entryB.id === e.id);
          return (
            <div key={e.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm" style={{ borderColor: isConflicted ? T.critical : T.border, background: isConflicted ? T.criticalTint : 'transparent' }}>
              <div>
                <p className="font-medium" style={{ color: T.ink }}>{d?.actualDay}, {p?.label}</p>
                <p className="text-xs" style={{ color: T.muted }}>{classLabel(state, c)} {'\u00b7'} {s?.name}</p>
              </div>
              {isConflicted && <AlertTriangle size={15} color={T.critical} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CreateTimetable({ state, actions, conflicts, initialClass = null }) {
  const [departmentId, setDepartmentId] = useState(initialClass?.departmentId || state.departments[0]?.id || '');
  const [batchEdit, setBatchEdit] = useState(null);
  const [year, setYear] = useState(initialClass?.year || 'III');
  const [sectionPick, setSectionPick] = useState(initialClass?.section || 'A');
  const [roomId, setRoomId] = useState('');
  // Coming here via "Edit" on a class's card in Timetable Overview: that class already
  // exists, so skip straight past the "Select class" step onto its schedule grid.
  const [confirmed, setConfirmed] = useState(!!initialClass);
  const [cell, setCell] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [changeText, setChangeText] = useState('');
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeLog, setChangeLog] = useState([]);
  const [undoSnap, setUndoSnap] = useState(null);
  // The AI call can take many seconds. `state`/`actions` captured when the button was
  // clicked are stale by the time it returns, so writing them back could silently drop
  // edits made meanwhile. Refs always point at the latest render.
  const stateRef = useRef(state); stateRef.current = state;
  const actionsRef = useRef(actions); actionsRef.current = actions;

  // ---- Which class is this? The Section box is only shown when this department + year really has
  // 2 or more classes. With one class there is nothing to choose, so it is used automatically.
  const yearSections = state.classSections
    .filter((c) => c.departmentId === departmentId && c.year === year)
    .sort((a, b) => String(a.section).localeCompare(String(b.section)));
  const multiSection = yearSections.length > 1;
  const section = multiSection
    ? (yearSections.some((c) => c.section === sectionPick) ? sectionPick : yearSections[0].section)
    : (yearSections[0]?.section || 'A');
  const existingClass = yearSections.find((c) => c.section === section);
  // an existing class keeps its own batch; a new one gets it from the year + academic year
  const batch = existingClass ? existingClass.batch : (batchEdit ?? batchForYear(state, year));

  const classSection = useMemo(() => {
    if (!confirmed) return null;
    let cs = state.classSections.find((c) => c.departmentId === departmentId && c.year === year && c.section === section);
    return cs;
  }, [confirmed, state.classSections, departmentId, year, section]);

  const classTitle = classSection ? classLabel(state, classSection) : departmentId + ' ' + year;

  function ensureClassSection() {
    let cs = state.classSections.find((c) => c.departmentId === departmentId && c.year === year && c.section === section);
    if (!cs) {
      cs = { id: uid('CLS'), departmentId, batch, year, semester: semesterForYear(year), section, roomId: roomId || null };
      actions.addRecord('classSections', cs, 'Class section created: ' + departmentId + ' ' + year + '-' + section);
    }
    setConfirmed(true);
  }

  // The class's PLAN: its saved allocations (subject + staff + hours for THIS section) when it
  // has any, otherwise the department's subjects of this year. Each item is flattened into the
  // subject shape the drawer / AI code already understands, with the section's own staff + hours.
  const planCs = classSection || { id: '__none__', departmentId, year };
  const deptSubjects = planForClassSection(state, planCs).map((i) => ({ ...i.subject, facultyIds: i.facultyIds, weeklyHours: i.weeklyHours }));
  const entriesForClass = classSection ? state.timetableEntries.filter((e) => e.classSectionId === classSection.id) : [];
  const periodSlots = state.periods.filter((p) => p.type === 'period');

  // Subjects for this class section that have nobody assigned to teach them.
  // Grok is never even shown these (buildPrompt drops any subject with an
  // empty eligibleFaculty list), so they can never be auto-filled until
  // master data is fixed - surface that up front instead of letting the
  // person guess why the grid stayed empty.
  const subjectsMissingFaculty = deptSubjects.filter((s) => !(s.facultyIds || []).length);

  // Rooms Grok is allowed to place this class in. If this department has zero
  // classrooms/labs in master data, Grok has nothing real to pick from and
  // ends up inventing a roomId that fails validation on every single entry
  // (surfaces as "unknown room \u00d7N" in the toast) - same class of problem
  // as missing faculty, just on the room side.
  const roomsForDept = [...state.classrooms, ...state.labs].filter((r) => r.departmentId === departmentId);

  // ---- Local auto-fill: no API, instant, can do a whole department in one click.
  function summarizeUnplaced(unplaced) {
    const names = new Map(state.subjects.map((s) => [s.id, s.name]));
    const secs = new Map(state.classSections.map((c) => [c.id, c]));
    return unplaced.slice(0, 3).map((u) => {
      const c = secs.get(u.classSectionId);
      return (c ? c.departmentId + ' ' + c.year + c.section + ' ' : '') + (names.get(u.subjectId) || u.subjectId) + ' (' + u.missing + 'h): ' + u.reason;
    }).join(' | ') + (unplaced.length > 3 ? ' | +' + (unplaced.length - 3) + ' more' : '');
  }

  function autoFill(scope) {
    if (!classSection) return;
    const targets = scope === 'department'
      ? state.classSections.filter((c) => c.departmentId === departmentId)
      : [classSection];
    const { entries, unplaced, stats, removeEntryIds } = generateForClasses({ state, classSections: targets });
    const dropIds = new Set(removeEntryIds);
    const cleaned = dropIds.size ? 'Removed ' + dropIds.size + ' broken period(s). ' : '';
    if (entries.length > 0 || dropIds.size > 0) {
      const label = scope === 'department' ? departmentId + ' (' + targets.length + ' classes)' : classTitle;
      actions.persist(actions.logActivity(
        { ...state, timetableEntries: [...state.timetableEntries.filter((e) => !dropIds.has(e.id)), ...entries] },
        'Auto-generated ' + entries.length + ' period(s) for ' + label,
        { entityType: 'timetable', entityId: departmentId },
      ));
    }
    if (stats.requiredHours === 0) { actions.toast(cleaned + 'Nothing to fill \u2014 every subject already has its weekly hours.', 'success'); return; }
    if (unplaced.length === 0) { actions.toast(cleaned + 'Filled ' + entries.length + ' period(s) in ' + stats.ms + ' ms. No conflicts.', 'success'); return; }
    actions.toast(cleaned + 'Placed ' + entries.length + ' of ' + stats.requiredHours + ' period(s). Not placed \u2014 ' + summarizeUnplaced(unplaced), entries.length > 0 ? 'warn' : 'critical');
  }

  // ---- Comment box: one small AI call turns a sentence into operations; everything after
  // that (legality checks, swaps, refilling) is local code, so the AI can't break the rules.
  async function applyChangeRequest() {
    if (!classSection || !changeText.trim() || changeBusy) return;
    setChangeBusy(true);
    setChangeLog([]);
    try {
      const cs = classSection;
      const { ops, note } = await parseChangeRequest({ state: stateRef.current, classSection: cs, text: changeText.trim() });
      if (!ops.length) {
        setChangeLog([{ ok: false, text: note || 'I could not turn that into a timetable change. Name the subject and the day / period, e.g. "move Data Structures from Day 1 to Wednesday".' }]);
        return;
      }
      const live = stateRef.current;
      const res = applyChangeOps({ state: live, classSection: cs, ops });
      let entries = res.entries;
      const log = [...res.log];
      if (res.needsRefill) {
        const gen = generateForClasses({ state: { ...live, timetableEntries: entries }, classSections: [cs], options: { forbid: res.forbid } });
        entries = [...entries, ...gen.entries];
        if (gen.entries.length) log.push({ ok: true, text: 'Re-filled ' + gen.entries.length + ' freed period(s) with subjects that still needed hours.' });
      }
      if (res.changes > 0) {
        setUndoSnap(live.timetableEntries.filter((e) => e.classSectionId === cs.id));
        actionsRef.current.persist(actionsRef.current.logActivity(
          { ...live, timetableEntries: entries },
          'Timetable changed by request: ' + classTitle,
          { entityType: 'timetable', entityId: departmentId },
        ));
        setChangeText('');
      }
      setChangeLog(log);
    } catch (err) {
      setChangeLog([{ ok: false, text: err?.message || 'Something went wrong.' }]);
    } finally {
      setChangeBusy(false);
    }
  }

  function undoChange() {
    if (!undoSnap || !classSection) return;
    const live = stateRef.current;
    actionsRef.current.persist(actionsRef.current.logActivity(
      { ...live, timetableEntries: [...live.timetableEntries.filter((e) => e.classSectionId !== classSection.id), ...undoSnap] },
      'Change undone: ' + classTitle,
      { entityType: 'timetable', entityId: departmentId },
    ));
    setUndoSnap(null);
    setChangeLog([{ ok: true, text: 'Last change undone.' }]);
  }

  function removeBroken() {
    if (!classSection) return;
    const bad = new Set(findOrphanEntries(state, [classSection.id]).map((e) => e.id));
    if (!bad.size) return;
    actions.persist(actions.logActivity(
      { ...state, timetableEntries: state.timetableEntries.filter((e) => !bad.has(e.id)) },
      'Removed ' + bad.size + ' broken period(s): ' + classTitle,
      { entityType: 'timetable', entityId: departmentId },
    ));
    actions.toast('Removed ' + bad.size + ' broken period(s). Auto-fill can now use those cells.', 'success');
  }

  function clearClass() {
    if (!classSection || entriesForClass.length === 0) return;
    if (!window.confirm('Remove all ' + entriesForClass.length + ' period(s) of ' + classTitle + '? This cannot be undone.')) return;
    actions.persist(actions.logActivity(
      { ...state, timetableEntries: state.timetableEntries.filter((e) => e.classSectionId !== classSection.id) },
      'Timetable cleared for ' + classTitle,
      { entityType: 'timetable', entityId: departmentId },
    ));
    actions.toast('Class timetable cleared.');
  }

  const coverage = classSection ? coverageForClass(state, classSection) : [];
  const plannedHours = coverage.filter((c) => !c.stray && !c.broken).reduce((s, c) => s + c.required, 0);
  const gridCells = state.dayOrders.length * periodSlots.length;

  async function generateWithAI() {
    if (!classSection || aiBusy) return;
    setAiBusy(true);
    try {
      const { entries, skipped } = await generateTimetableWithAI({
        state, departmentId, classSection, deptSubjects, periodSlots,
        // Groq's per-minute token limit can trip a 429 on a busy session - the fetch
        // layer already retries automatically, this just keeps the person informed
        // instead of the button looking stuck for up to ~20s per retry.
        onRetry: (attempt, waitMs) => {
          actions.toast('Groq rate limit hit \u2014 retrying automatically in ' + Math.round(waitMs / 1000) + 's (attempt ' + attempt + ')\u2026', 'warn');
        },
      });

      // Always keep whatever Grok managed to place, however small - the
      // remaining cells simply stay empty for manual entry rather than the
      // whole run being thrown away because *some* slots couldn't be placed.
      if (entries.length > 0) {
        const liveState = stateRef.current;
        const liveActions = actionsRef.current;
        const next = {
          ...liveState,
          timetableEntries: [...liveState.timetableEntries, ...entries],
        };
        liveActions.persist(liveActions.logActivity(next, 'AI generated ' + entries.length + ' slot(s) for ' + classTitle, { entityType: 'timetable', entityId: departmentId }));
      }

      if (entries.length === 0 && skipped.length === 0) {
        actions.toast('Nothing to fill \u2014 the grid is already complete.', 'success');
        return;
      }

      if (skipped.length === 0) {
        actions.toast('Grok filled ' + entries.length + ' slot(s).', 'success');
        return;
      }

      // Summarize *why* the rest got skipped, so it's fixable instead of a
      // dead end. Count reason frequency across all skipped items.
      const reasonCounts = {};
      skipped.forEach(({ reasons }) => reasons.forEach((r) => { reasonCounts[r] = (reasonCounts[r] || 0) + 1; }));
      const topReasons = Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([r, n]) => r + ' \u00d7' + n)
        .join(', ');

      const filledPart = entries.length > 0 ? 'Filled ' + entries.length + ' slot(s), left ' + skipped.length + ' empty' : 'Could not place any of the ' + skipped.length + ' slot(s) it tried';
      const missingPart = subjectsMissingFaculty.length
        ? ' \u2014 ' + subjectsMissingFaculty.length + ' subject(s) have no faculty assigned (' + subjectsMissingFaculty.map((s) => s.name).join(', ') + ')'
        : (topReasons ? ' \u2014 mainly: ' + topReasons : '');

      actions.toast(filledPart + missingPart + '. Remaining cells are left blank for manual entry.', entries.length > 0 ? 'warn' : 'critical');
    } catch (err) {
      actions.toast(err?.message || 'AI generation failed.', 'critical');
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-1 text-xs font-semibold" style={{ color: T.muted }}>
        <span style={{ color: confirmed ? T.primary : T.muted }}>01 Select class</span>
        <ChevronRight size={12} />
        <span style={{ color: confirmed ? T.ink : T.muted }}>02 Build schedule</span>
        <ChevronRight size={12} />
        <span>03 Validate</span>
        <ChevronRight size={12} />
        <span>04 Publish</span>
      </div>

      <Card className="mb-5 p-4">
        <div className={'grid grid-cols-2 gap-3 ' + (multiSection ? 'sm:grid-cols-5' : 'sm:grid-cols-4')}>
          <Field label="Department">
            <Select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setBatchEdit(null); setConfirmed(false); }}>
              {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
            </Select>
          </Field>
          <Field label="Batch"><Input value={batch} disabled={!!existingClass} onChange={(e) => setBatchEdit(e.target.value)} title={existingClass ? 'Batch of the existing class' : 'Set from the year and the academic year'} /></Field>
          <Field label="Year">
            <Select value={year} onChange={(e) => { setYear(e.target.value); setBatchEdit(null); setConfirmed(false); }}>
              {['I', 'II', 'III', 'IV'].map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          </Field>
          {multiSection && (
            <Field label="Section">
              <Select value={section} onChange={(e) => { setSectionPick(e.target.value); setConfirmed(false); }}>
                {yearSections.map((c) => <option key={c.id} value={c.section}>{c.section}</option>)}
              </Select>
            </Field>
          )}
          <Field label="Lecture hall">
            <Select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Select room</option>
              {state.classrooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        </div>
        <div className="mt-4">
          <PrimaryButton onClick={ensureClassSection}>{confirmed ? 'Class loaded' : 'Load class'}</PrimaryButton>
          {yearSections.length === 0 && (
            <p className="mt-2 text-xs" style={{ color: T.muted }}>
              {departmentId} has no {year} year class yet. "Load class" creates it as a single class. For sections A, B, C use Master Data {'\u2192'} Departments {'\u2192'} Add classes.
            </p>
          )}
        </div>
      </Card>

      {confirmed && classSection && (
        <>
          <ClassAllocationPanel key={classSection.id} state={state} actions={actions} classSection={classSection} />

          <Card className="mb-5 p-4">
            <p className="ts-display mb-1 text-sm font-semibold" style={{ color: T.ink }}>Change this timetable by comment</p>
            <p className="mb-2 text-xs" style={{ color: T.muted }}>Describe the change in your own words (English / Tamil / Tanglish). The AI only understands the sentence; moving, swapping and every clash check is done by the app.</p>
            <div className="flex flex-wrap items-start gap-2">
              <textarea
                value={changeText}
                onChange={(e) => setChangeText(e.target.value)}
                rows={2}
                disabled={!isGrokConfigured() || changeBusy}
                placeholder={'e.g. Day 1 la Data Structures venaam, vera subject podu, DS ah Wednesday ku maathu'}
                className="min-w-[260px] flex-1 rounded-lg border px-3 py-2 text-sm"
                style={{ borderColor: T.border, color: T.ink }}
              />
              <div className="flex flex-col gap-2">
                <PrimaryButton icon={Sparkles} onClick={applyChangeRequest} disabled={!isGrokConfigured() || changeBusy || !changeText.trim()}>
                  {changeBusy ? 'Working\u2026' : 'Apply change'}
                </PrimaryButton>
                {undoSnap && <GhostButton onClick={undoChange} disabled={changeBusy}>Undo last change</GhostButton>}
              </div>
            </div>
            {!isGrokConfigured() && <p className="mt-2 text-xs" style={{ color: T.warn }}>Add VITE_GROK_API_KEY to .env.local to enable the comment box (Auto-fill works without it).</p>}
            {changeLog.length > 0 && (
              <ul className="mt-3 space-y-1">
                {changeLog.map((l, i) => (
                  <li key={i} className="text-xs" style={{ color: l.ok ? T.success : T.critical }}>{l.ok ? '\u2713 ' : '\u2717 '}{l.text}</li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="overflow-x-auto p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="ts-display text-sm font-semibold" style={{ color: T.ink }}>{classTitle} timetable grid</p>
              <div className="flex items-center gap-2">
                <PrimaryButton icon={Sparkles} onClick={() => autoFill('class')} disabled={aiBusy}>Auto-fill this class</PrimaryButton>
                <GhostButton onClick={() => autoFill('department')} disabled={aiBusy}>Auto-fill all {departmentId} classes</GhostButton>
                {isGrokConfigured() && (
                  <GhostButton onClick={generateWithAI} disabled={aiBusy}>
                    {aiBusy ? 'Asking AI\u2026' : 'Ask AI for remaining cells'}
                  </GhostButton>
                )}
                <GhostButton tone="critical" icon={Trash2} onClick={clearClass} disabled={aiBusy || entriesForClass.length === 0}>Clear</GhostButton>
              </div>
            </div>
            {subjectsMissingFaculty.length > 0 && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: T.warn, background: T.warnTint, color: T.warn }}>
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  {subjectsMissingFaculty.length} subject(s) have no faculty assigned yet, so auto-fill will always leave those periods empty:{' '}
                  <strong>{subjectsMissingFaculty.map((s) => s.name).join(', ')}</strong>. Assign faculty to them in Master Data {'\u2192'} Subjects first for a fuller auto-fill.
                </span>
              </div>
            )}
            {roomsForDept.length === 0 && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: T.warn, background: T.warnTint, color: T.warn }}>
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  <strong>{departmentId}</strong> has no classrooms or labs in Master Data yet. Auto-fill will still place subjects and faculty{' \u2014 '}room assignments will show as{' '}
                  <strong>Not Assigned</strong> until you add rooms in Master Data{' \u2192 '}Classrooms & Labs.
                </span>
              </div>
            )}
            <table className="w-full min-w-[720px] table-fixed border-collapse text-xs">
              <thead>
                <tr>
                  <th className="w-16 border p-2 text-left font-semibold" style={{ borderColor: T.border, color: T.muted, background: T.bg }}>Day order</th>
                  {periodSlots.map((p) => (
                    <th key={p.id} className="border p-2 text-center font-semibold" style={{ borderColor: T.border, color: T.muted, background: T.bg }}>
                      <div>{p.label}</div>
                      <div className="ts-mono font-normal" style={{ color: T.muted }}>{p.start}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.dayOrders.map((d) => (
                  <tr key={d.id}>
                    <td className="ts-mono border p-2 text-center font-bold" style={{ borderColor: T.border, color: T.primary }}>{d.label}</td>
                    {periodSlots.map((p) => {
                      const entry = entriesForClass.find((e) => e.dayOrderId === d.id && e.periodId === p.id);
                      const isConflicted = entry && conflicts.some((c) => c.entryA.id === entry.id || c.entryB.id === entry.id);
                      const subj = entry && state.subjects.find((s) => s.id === entry.subjectId);
                      const fac = entry && state.faculty.find((f) => f.id === entry.facultyId);
                      // Room is optional on an entry - look it up only when one is actually
                      // assigned, and show a plain "-" (not blank, not an error) when it isn't,
                      // so the cell always makes it obvious a room was never required to schedule
                      // this slot in the first place.
                      const room = entry?.roomId
                        ? state.classrooms.find((r) => r.id === entry.roomId) || state.labs.find((r) => r.id === entry.roomId)
                        : null;
                      return (
                        <td
                          key={p.id}
                          onClick={() => setCell({ dayOrderId: d.id, periodId: p.id, entry })}
                          className="cursor-pointer border p-1.5 align-top transition-colors hover:bg-gray-50"
                          style={{ borderColor: isConflicted ? T.critical : T.border, background: isConflicted ? T.criticalTint : 'transparent' }}
                        >
                          {entry ? (
                            <div>
                              <p className="font-semibold" style={{ color: T.ink }}>{subj?.name}</p>
                              <p style={{ color: T.muted }}>{fac?.name}</p>
                              <p className="ts-mono" style={{ color: T.muted }}>{room ? room.name : '-'}</p>
                              {isConflicted && <p className="mt-0.5 font-semibold" style={{ color: T.critical }}>Conflict</p>}
                            </div>
                          ) : (
                            <p className="text-center" style={{ color: T.muted }}>+</p>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {coverage.length > 0 && (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {coverage.map((c) => {
                    const bad = c.stray || c.broken || c.scheduled > c.required;
                    const color = bad ? T.critical : c.scheduled === c.required ? T.success : T.warn;
                    return (
                      <span key={c.subjectId} className="rounded-full border px-2.5 py-0.5 text-xs" style={{ borderColor: color, color }}>
                        {c.broken ? c.name + ' \u00d7' + c.scheduled : c.stray ? c.name + ' \u00d7' + c.scheduled + ' (not in this class\u2019s plan)' : c.name + ' ' + c.scheduled + '/' + c.required}
                      </span>
                    );
                  })}
                  {coverage.some((c) => c.broken) && <GhostButton tone="critical" onClick={removeBroken}>Remove broken entries</GhostButton>}
                </div>
                {plannedHours >= gridCells && (
                  <p className="mt-2 text-xs" style={{ color: T.warn }}>
                    {plannedHours} planned period(s) for {gridCells} grid cells: there is no free period left, so any single clash leaves a subject unplaced. Check the weekly hours in Class allocation.
                  </p>
                )}
              </>
            )}
          </Card>

          <div className="mt-5">
            <ExportToolbar state={state} classSection={classSection} entries={entriesForClass} departmentId={departmentId} year={year} section={multiSection ? section : ''} batch={batch} toast={actions.toast} />
          </div>
        </>
      )}

      {cell && (
        <AssignmentDrawer
          state={state} actions={actions} cell={cell} classSection={classSection}
          deptSubjects={deptSubjects} departmentId={departmentId}
          onClose={() => setCell(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Class allocation: for ONE class section, which subjects it studies, who teaches
// each, and how many periods a week. This is what lets CSE-A and CSE-B have
// different staff for the same subject, a common subject have a different teacher
// in every department, and one teacher be tied to specific classes.
// ---------------------------------------------------------------------------
function ClassAllocationPanel({ state, actions, classSection: cs }) {
  const saved = (state.classAssignments || []).filter((a) => a.classSectionId === cs.id);
  const [open, setOpen] = useState(saved.length === 0);
  const [showOtherYears, setShowOtherYears] = useState(false);
  const [copyFrom, setCopyFrom] = useState('');
  const [rows, setRows] = useState({});

  function initialRows() {
    const out = {};
    if (saved.length) {
      saved.forEach((a) => {
        const s = state.subjects.find((x) => x.id === a.subjectId);
        out[a.subjectId] = { enabled: true, facultyId: a.facultyId || '', weeklyHours: String(a.weeklyHours ?? s?.weeklyHours ?? '') };
      });
    } else {
      // no allocation yet: pre-fill from the subject master so it is only a review + Save
      state.subjects
        .filter((s) => (s.departmentIds || []).includes(cs.departmentId) && (!s.year || s.year === cs.year))
        .forEach((s) => { out[s.id] = { enabled: true, facultyId: (s.facultyIds || []).length === 1 ? s.facultyIds[0] : '', weeklyHours: String(s.weeklyHours || '') }; });
    }
    return out;
  }
  useEffect(() => { setRows(initialRows()); }, [cs.id, saved.length]);

  const candidates = state.subjects
    .filter((s) => (s.departmentIds || []).includes(cs.departmentId) || rows[s.id])
    .filter((s) => showOtherYears || !s.year || s.year === cs.year || rows[s.id]?.enabled)
    .sort((a, b) => Number(b.year === cs.year) - Number(a.year === cs.year) || a.name.localeCompare(b.name));

  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { enabled: false, facultyId: '', weeklyHours: '', ...(r[id] || {}), ...patch } }));
  const enabledIds = Object.keys(rows).filter((id) => rows[id]?.enabled);
  const totalHours = enabledIds.reduce((sum, id) => sum + (Number(rows[id].weeklyHours) || 0), 0);
  const cells = state.dayOrders.length * state.periods.filter((p) => p.type === 'period').length;
  const otherSections = state.classSections.filter((c) => c.id !== cs.id && (state.classAssignments || []).some((a) => a.classSectionId === c.id));

  function copy() {
    const from = (state.classAssignments || []).filter((a) => a.classSectionId === copyFrom);
    if (!from.length) return;
    const next = {};
    from.forEach((a) => {
      const s = state.subjects.find((x) => x.id === a.subjectId);
      next[a.subjectId] = { enabled: true, facultyId: a.facultyId || '', weeklyHours: String(a.weeklyHours ?? s?.weeklyHours ?? '') };
    });
    setRows(next);
    actions.toast('Copied. Change the staff that differ for this section, then Save.', 'success');
  }

  function save() {
    const next = enabledIds.map((subjectId) => ({
      id: 'CA-' + cs.id + '-' + subjectId,
      classSectionId: cs.id,
      subjectId,
      facultyId: rows[subjectId].facultyId || null,
      weeklyHours: Number(rows[subjectId].weeklyHours) || null,
    }));
    const others = (state.classAssignments || []).filter((a) => a.classSectionId !== cs.id);
    actions.persist(actions.logActivity(
      { ...state, classAssignments: [...others, ...next] },
      'Class allocation saved: ' + classLabel(state, cs) + ' (' + next.length + ' subject(s))',
      { entityType: 'timetable', entityId: cs.departmentId },
    ));
    actions.toast('Class allocation saved. Auto-fill will now use exactly this staff.', 'success');
  }

  return (
    <Card className="mb-5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="ts-display text-sm font-semibold" style={{ color: T.ink }}>Class allocation {'\u2014'} who teaches what in {classLabel(state, cs)}</p>
          <p className="text-xs" style={{ color: T.muted }}>
            {saved.length ? saved.length + ' subject(s) allocated to this section.' : 'Not saved yet \u2014 auto-fill uses any eligible teacher until you save this.'}
          </p>
        </div>
        <GhostButton onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Edit allocation'}</GhostButton>
      </div>

      {open && (
        <div className="mt-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {otherSections.length > 0 && (
              <>
                <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                  <option value="">Copy from another class{'\u2026'}</option>
                  {otherSections.map((c) => <option key={c.id} value={c.id}>{classLabel(state, c)}</option>)}
                </Select>
                <GhostButton onClick={copy} disabled={!copyFrom}>Copy</GhostButton>
              </>
            )}
            <label className="flex items-center gap-1.5 text-xs" style={{ color: T.muted }}>
              <input type="checkbox" checked={showOtherYears} onChange={(e) => setShowOtherYears(e.target.checked)} /> show other years' subjects
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs" style={{ color: T.muted }}>
                  <th className="px-2 py-1">Taught</th><th className="px-2 py-1">Subject</th><th className="px-2 py-1">Teacher for this section</th><th className="px-2 py-1">Periods / week</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((s) => {
                  const r = rows[s.id] || { enabled: false, facultyId: '', weeklyHours: String(s.weeklyHours || '') };
                  const eligible = state.faculty.filter((f) => (s.facultyIds || []).includes(f.id));
                  const others = state.faculty.filter((f) => !(s.facultyIds || []).includes(f.id));
                  return (
                    <tr key={s.id} className="border-t" style={{ borderColor: T.border, opacity: r.enabled ? 1 : 0.55 }}>
                      <td className="px-2 py-1.5"><input type="checkbox" checked={!!r.enabled} onChange={(e) => setRow(s.id, { enabled: e.target.checked, weeklyHours: r.weeklyHours || String(s.weeklyHours || '') })} /></td>
                      <td className="px-2 py-1.5" style={{ color: T.ink }}>{s.name} <span className="text-xs" style={{ color: T.muted }}>{s.year} {'\u00b7'} {s.type}{(s.departmentIds || []).length > 1 ? ' \u00b7 common' : ''}</span></td>
                      <td className="px-2 py-1.5">
                        <Select value={r.facultyId} onChange={(e) => setRow(s.id, { facultyId: e.target.value, enabled: true })}>
                          <option value="">Any eligible teacher (auto)</option>
                          {eligible.length > 0 && <optgroup label="Eligible for this subject">{eligible.map((f) => <option key={f.id} value={f.id}>{f.name} {'\u00b7'} {f.departmentId}</option>)}</optgroup>}
                          <optgroup label="Other staff (any department)">{others.map((f) => <option key={f.id} value={f.id}>{f.name} {'\u00b7'} {f.departmentId}</option>)}</optgroup>
                        </Select>
                      </td>
                      <td className="px-2 py-1.5"><Input type="number" min="0" max="12" value={r.weeklyHours} onChange={(e) => setRow(s.id, { weeklyHours: e.target.value })} style={{ width: 80 }} /></td>
                    </tr>
                  );
                })}
                {candidates.length === 0 && <tr><td colSpan={4} className="px-2 py-3 text-xs" style={{ color: T.muted }}>No subjects for this department yet. Add them in Master Data first.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <PrimaryButton onClick={save}>Save allocation</PrimaryButton>
            <span className="text-xs" style={{ color: totalHours > cells ? T.critical : totalHours === cells ? T.warn : T.muted }}>
              {totalHours} of {cells} periods planned{totalHours > cells ? ' \u2014 more than the grid can hold' : totalHours === cells ? ' \u2014 no free period left' : ''}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function AssignmentDrawer({ state, actions, cell, classSection, deptSubjects, departmentId, onClose }) {
  const [subjectId, setSubjectId] = useState(cell.entry?.subjectId || '');
  const [facultyId, setFacultyId] = useState(cell.entry?.facultyId || '');
  const [roomId, setRoomId] = useState(cell.entry?.roomId || classSection.roomId || '');
  const [entryType, setEntryType] = useState(cell.entry?.type || 'theory');
  const [pendingConflict, setPendingConflict] = useState(null);

  const subject = state.subjects.find((s) => s.id === subjectId);
  // deptSubjects carries the CLASS's own staff (allocation) when one exists.
  const planned = deptSubjects.find((s) => s.id === subjectId);
  const allowedFacultyIds = planned ? planned.facultyIds : (subject?.facultyIds || []);
  const eligibleFaculty = subject ? state.faculty.filter((f) => allowedFacultyIds.includes(f.id)) : [];

  useEffect(() => {
    if (subject && allowedFacultyIds.length === 1) setFacultyId(allowedFacultyIds[0]);
  }, [subjectId]);

  function buildEntry() {
    return {
      id: cell.entry?.id || uid('TT'),
      departmentId, classSectionId: classSection.id,
      dayOrderId: cell.dayOrderId, periodId: cell.periodId,
      // Room is optional - store a real null rather than '' so an unassigned room
      // never accidentally matches another unassigned room as a "conflict" below,
      // and so it round-trips cleanly through Supabase as an empty FK, not a string.
      subjectId, facultyId, roomId: roomId || null, type: entryType,
    };
  }

  function wouldConflict(entry) {
    const subjectsById = new Map(state.subjects.map((s) => [s.id, s]));
    return state.timetableEntries.some((e) =>
      e.id !== entry.id && e.dayOrderId === entry.dayOrderId && e.periodId === entry.periodId &&
      !isCombinedPair(e, entry, subjectsById) &&
      (e.facultyId === entry.facultyId || (entry.roomId && e.roomId === entry.roomId) || e.classSectionId === entry.classSectionId)
    );
  }

  function attemptAssign() {
    if (!subjectId || !facultyId) { actions.toast('Choose a subject and faculty.', 'critical'); return; }
    const entry = buildEntry();
    if (wouldConflict(entry)) {
      setPendingConflict(entry);
      return;
    }
    saveEntry(entry);
  }

  function saveEntry(entry) {
    const exists = state.timetableEntries.some((e) => e.id === entry.id);
    const next = exists
      ? { ...state, timetableEntries: state.timetableEntries.map((e) => (e.id === entry.id ? entry : e)) }
      : { ...state, timetableEntries: [...state.timetableEntries, entry] };
    actions.persist(actions.logActivity(next, departmentId + ' timetable updated', { entityType: 'timetable', entityId: departmentId }));
    actions.toast('Timetable assignment saved.');
    onClose();
  }

  return (
    <Drawer open onClose={onClose} title="Assign slot">
      {pendingConflict ? (
        <div>
          <div className="mb-4 rounded-lg border p-3" style={{ borderColor: T.critical, background: T.criticalTint }}>
            <p className="flex items-center gap-1.5 text-sm font-semibold" style={{ color: T.critical }}><AlertTriangle size={15} /> Faculty scheduling conflict</p>
            <p className="mt-1 text-xs" style={{ color: T.critical }}>This faculty, room, or class is already booked for this exact Day Order and Period. Saving anyway will create a visible conflict in the Conflict Center.</p>
          </div>
          <div className="flex gap-2">
            <PrimaryButton onClick={() => saveEntry(pendingConflict)} className="bg-transparent">Save anyway</PrimaryButton>
            <GhostButton onClick={() => setPendingConflict(null)}>Choose a different slot</GhostButton>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Subject">
            <Select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setFacultyId(''); }}>
              <option value="">Select subject</option>
              {deptSubjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Faculty">
            <Select value={facultyId} onChange={(e) => setFacultyId(e.target.value)} disabled={!subject}>
              <option value="">{subject ? 'Select faculty' : 'Choose a subject first'}</option>
              {eligibleFaculty.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </Select>
          </Field>
          <Field label="Room">
            <Select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">Select room</option>
              {[...state.classrooms, ...state.labs].map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
          <Field label="Type">
            <Select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
              <option value="theory">Theory</option>
              <option value="lab">Lab</option>
            </Select>
          </Field>
          <div className="flex gap-2 pt-2">
            <PrimaryButton onClick={attemptAssign}>Assign</PrimaryButton>
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            {cell.entry && (
              <GhostButton
                tone="critical"
                icon={Trash2}
                onClick={() => {
                  const next = { ...state, timetableEntries: state.timetableEntries.filter((e) => e.id !== cell.entry.id) };
                  actions.persist(next);
                  actions.toast('Slot cleared.');
                  onClose();
                }}
              >
                Remove
              </GhostButton>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

// Draws the timetable sheet directly onto a <canvas> using the 2D drawing API —
// no DOM screenshot involved. This guarantees output (text/boxes we draw ourselves
// always show up), unlike html-to-image's DOM-to-SVG-to-canvas approach, which
// produced a blank image with no console error, most likely due to the browser
// blocking cross-origin stylesheet access during its internal capture step.
function drawTimetableCanvas({ state, entries, subjectRows, room, department, departmentId, year, section, batch }) {
  const scale = 2; // render at 2x for crisp output, like pixelRatio did before
  const width = 1000;
  const padding = 24;
  const rowH = 22;
  const periods = state.periods;
  const dayOrders = state.dayOrders;

  const headerH = 92;
  const infoTableH = rowH * 3 + 16;
  const titleH = 26;
  const classHeaderRowH = 40;
  const classRowH = 30;
  const classTableH = classHeaderRowH + dayOrders.length * classRowH;
  const subjectHeaderRowH = 26;
  const subjectRowH = 24;
  const subjectTableH = subjectHeaderRowH + Math.max(subjectRows.length, 1) * subjectRowH;
  const totalHeight = padding * 2 + headerH + infoTableH + titleH + classTableH + 24 + titleH + subjectTableH;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = totalHeight * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // background + outer border
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, totalHeight);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, width - 2, totalHeight - 2);

  let y = padding;
  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.font = 'bold 18px Arial';
  ctx.fillText(state.college?.name || '', width / 2, y + 18);
  y += 32;
  ctx.font = '12px Arial';
  ctx.fillText('COLLEGE OF ENGINEERING AND TECHNOLOGY', width / 2, y);
  y += 24;
  ctx.font = 'bold 13px Arial';
  ctx.fillText('DEPARTMENT OF ' + (department?.name || departmentId).toUpperCase(), width / 2, y);
  y += 16;
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(width - padding, y);
  ctx.stroke();
  y += 20;

  // info block
  ctx.textAlign = 'left';
  const c1 = padding, c2 = padding + 150, c3 = padding + 360, c4 = padding + 500;
  function infoRow(la, va, lb, vb) {
    ctx.font = 'bold 12px Arial';
    ctx.fillText(la, c1, y);
    ctx.font = '12px Arial';
    ctx.fillText(String(va ?? ''), c2, y);
    ctx.font = 'bold 12px Arial';
    ctx.fillText(lb, c3, y);
    ctx.font = '12px Arial';
    ctx.fillText(String(vb ?? ''), c4, y);
    y += rowH;
  }
  infoRow('Batch', batch, 'Year/Sem', year + (section ? ' / ' + section : ''));
  infoRow('Academic Year', state.college?.academicYear, 'Lecture Hall', room?.name || 'Not Assigned');
  ctx.font = 'bold 12px Arial';
  ctx.fillText('Degree / Branch', c1, y);
  ctx.font = '12px Arial';
  ctx.fillText('B.E / ' + departmentId, c2, y);
  y += rowH + 12;

  // CLASS TIME TABLE title
  ctx.textAlign = 'center';
  ctx.font = 'bold 13px Arial';
  ctx.fillText('CLASS TIME TABLE', width / 2, y);
  y += 16;

  const tableX = padding;
  const tableW = width - padding * 2;
  const dayColW = 70;
  const periodColW = (tableW - dayColW) / Math.max(periods.length, 1);
  const tableTop = y;

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#111111';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(tableX, tableTop, dayColW, classHeaderRowH);
  ctx.strokeRect(tableX, tableTop, dayColW, classHeaderRowH);
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 10px Arial';
  ctx.fillText('Day Order', tableX + dayColW / 2, tableTop + classHeaderRowH / 2 + 4);

  periods.forEach((p, i) => {
    const cx = tableX + dayColW + i * periodColW;
    ctx.fillStyle = p.type === 'break' ? '#eeeeee' : '#ffffff';
    ctx.fillRect(cx, tableTop, periodColW, classHeaderRowH);
    ctx.strokeStyle = '#111111';
    ctx.strokeRect(cx, tableTop, periodColW, classHeaderRowH);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 9px Arial';
    ctx.fillText(p.label, cx + periodColW / 2, tableTop + 16);
    ctx.font = '8px Arial';
    ctx.fillText((p.start || '') + ' - ' + (p.end || ''), cx + periodColW / 2, tableTop + 30);
  });

  let rowY = tableTop + classHeaderRowH;
  dayOrders.forEach((d) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(tableX, rowY, dayColW, classRowH);
    ctx.strokeStyle = '#111111';
    ctx.strokeRect(tableX, rowY, dayColW, classRowH);
    ctx.fillStyle = '#111111';
    ctx.font = 'bold 11px Arial';
    ctx.fillText(d.label, tableX + dayColW / 2, rowY + classRowH / 2 + 4);

    periods.forEach((p, i) => {
      const cx = tableX + dayColW + i * periodColW;
      if (p.type === 'break') {
        ctx.fillStyle = '#f5f5f5';
        ctx.fillRect(cx, rowY, periodColW, classRowH);
        ctx.fillStyle = '#888888';
        ctx.font = '9px Arial';
        ctx.fillText(p.label, cx + periodColW / 2, rowY + classRowH / 2 + 4);
      } else {
        const e = entries.find((x) => x.dayOrderId === d.id && x.periodId === p.id);
        const s = e && state.subjects.find((x) => x.id === e.subjectId);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx, rowY, periodColW, classRowH);
        ctx.fillStyle = '#111111';
        ctx.font = '9px Arial';
        ctx.fillText(s?.code || '', cx + periodColW / 2, rowY + classRowH / 2 + 4);
      }
      ctx.strokeStyle = '#111111';
      ctx.strokeRect(cx, rowY, periodColW, classRowH);
    });
    rowY += classRowH;
  });

  y = rowY + 24;
  ctx.textAlign = 'center';
  ctx.font = 'bold 13px Arial';
  ctx.fillText('SUBJECT ALLOCATION', width / 2, y);
  y += 16;

  const subCols = [
    { label: 'S.No', w: 50, align: 'center' },
    { label: 'Code', w: 90, align: 'center' },
    { label: 'Subject Name', w: 320, align: 'left' },
    { label: 'Faculty Name', w: 0, align: 'left' },
  ];
  subCols[3].w = tableW - (subCols[0].w + subCols[1].w + subCols[2].w);

  let sx = tableX;
  ctx.font = 'bold 11px Arial';
  subCols.forEach((c) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(sx, y, c.w, subjectHeaderRowH);
    ctx.strokeStyle = '#111111';
    ctx.strokeRect(sx, y, c.w, subjectHeaderRowH);
    ctx.fillStyle = '#111111';
    ctx.textAlign = 'center';
    ctx.fillText(c.label, sx + c.w / 2, y + subjectHeaderRowH / 2 + 4);
    sx += c.w;
  });

  let sy = y + subjectHeaderRowH;
  ctx.font = '10px Arial';
  if (subjectRows.length === 0) {
    ctx.strokeRect(tableX, sy, tableW, subjectRowH);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#888888';
    ctx.fillText('No subjects allocated yet', tableX + tableW / 2, sy + subjectRowH / 2 + 4);
  } else {
    subjectRows.forEach((s, i) => {
      let cx2 = tableX;
      const vals = [String(i + 1), s.code || '', s.name || '', s.facultyNames || ''];
      subCols.forEach((c, ci) => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx2, sy, c.w, subjectRowH);
        ctx.strokeStyle = '#111111';
        ctx.strokeRect(cx2, sy, c.w, subjectRowH);
        ctx.fillStyle = '#111111';
        ctx.textAlign = c.align;
        const tx = c.align === 'left' ? cx2 + 6 : cx2 + c.w / 2;
        ctx.fillText(vals[ci], tx, sy + subjectRowH / 2 + 4);
        cx2 += c.w;
      });
      sy += subjectRowH;
    });
  }

  return { canvas, scale };
}

function ExportToolbar({ state, classSection, entries, departmentId, year, section, batch, toast }) {
  const [busy, setBusy] = useState(null); // 'png' | 'pdf' | null

  const room = state.classrooms.find((r) => r.id === classSection?.roomId) || state.labs.find((r) => r.id === classSection?.roomId);
  const department = state.departments.find((d) => d.id === departmentId);
  const fileBase = [departmentId, year, section, 'timetable'].filter(Boolean).join('-').replace(/\s+/g, '_');

  const subjectRows = state.subjects
    .filter((s) => (s.departmentIds || []).includes(departmentId))
    .map((s) => ({
      ...s,
      facultyNames: state.faculty.filter((f) => s.facultyIds.includes(f.id)).map((f) => f.name).join(', ') || '\u2014',
    }));

  async function handleDownload(type) {
    setBusy(type);
    try {
      const { canvas, scale } = drawTimetableCanvas({ state, entries, subjectRows, room, department, departmentId, year, section, batch });
      const dataUrl = canvas.toDataURL('image/png');
      const w = canvas.width / scale;
      const h = canvas.height / scale;
      if (type === 'png') {
        const link = document.createElement('a');
        link.download = fileBase + '.png';
        link.href = dataUrl;
        link.click();
      } else {
        const pdf = new jsPDF({
          orientation: w > h ? 'landscape' : 'portrait',
          unit: 'pt',
          format: [w, h],
        });
        pdf.addImage(dataUrl, 'PNG', 0, 0, w, h);
        pdf.save(fileBase + '.pdf');
      }
      toast((type === 'png' ? 'PNG' : 'PDF') + ' downloaded.');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Timetable export failed', err);
      toast('Could not generate the ' + type.toUpperCase() + ' \u2014 ' + (err?.message || 'unknown error'), 'critical');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" style={{ color: T.muted }}>Export the {classLabel(state, classSection)} timetable for distribution.</p>
        <div className="no-print flex gap-2">
          <GhostButton icon={FileText} onClick={() => handleDownload('pdf')} disabled={busy !== null}>
            {busy === 'pdf' ? 'Generating\u2026' : 'Download PDF'}
          </GhostButton>
          <GhostButton icon={Download} onClick={() => handleDownload('png')} disabled={busy !== null}>
            {busy === 'png' ? 'Generating\u2026' : 'Download PNG'}
          </GhostButton>
          <GhostButton icon={Printer} onClick={() => window.print()}>Print</GhostButton>
        </div>
      </div>
    </Card>
  );
}

function ConflictCard({ c, state, onView, highlightId }) {
  const [flashing, ref] = useFlashHighlight(highlightId, c.id);
  return (
    <Card ref={ref} className="p-4" style={{ borderColor: T.critical, boxShadow: flashing ? `0 0 0 2px ${T.critical}` : 'none' }}>
      <div className="mb-2 flex items-center justify-between">
        <Badge tone="critical">Critical</Badge>
        <span className="text-xs capitalize" style={{ color: T.muted }}>{c.type} conflict</span>
      </div>
      {c.type === 'faculty' && <p className="text-sm font-semibold" style={{ color: T.ink }}>{c.fac?.name}</p>}
      <p className="mt-1 text-sm" style={{ color: T.ink }}>
        {classLabel(state, c.classA)} <ArrowRight size={11} className="mx-1 inline" /> vs <ArrowRight size={11} className="mx-1 inline" /> {classLabel(state, c.classB)}
      </p>
      <p className="mt-1 text-xs" style={{ color: T.muted }}>{c.dayOrder?.actualDay} {'\u00b7'} {c.period?.label}</p>
      <div className="mt-3 flex gap-2">
        <GhostButton onClick={() => onView(c)}>View</GhostButton>
        <PrimaryButton onClick={() => onView(c)}>Resolve</PrimaryButton>
      </div>
    </Card>
  );
}

function ConflictCenter({ state, actions, conflicts, highlightId = null }) {
  const [filter, setFilter] = useState('All');
  const [resolveTarget, setResolveTarget] = useState(null);
  const types = ['All', 'faculty', 'classroom', 'class'];
  const filtered = filter === 'All' ? conflicts : conflicts.filter((c) => c.type === filter);

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg p-1" style={{ background: '#EEF1F4', width: 'fit-content' }}>
        {types.map((t) => (
          <button key={t} onClick={() => setFilter(t)} className="rounded-md px-3 py-1.5 text-sm font-medium capitalize"
            style={{ background: filter === t ? T.surface : 'transparent', color: filter === t ? T.primary : T.muted }}>
            {t}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="No conflicts found." subtitle={'Every timetable slot across departments is clear \u2014 nice work.'} />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {filtered.map((c) => (
            <ConflictCard key={c.id} c={c} state={state} onView={setResolveTarget} highlightId={highlightId} />
          ))}
        </div>
      )}

      {resolveTarget && (
        <Drawer open onClose={() => setResolveTarget(null)} title="Resolve conflict">
          <ResolveConflictPanel state={state} actions={actions} conflict={resolveTarget} onClose={() => setResolveTarget(null)} />
        </Drawer>
      )}
    </div>
  );
}

function ResolveConflictPanel({ state, actions, conflict, onClose }) {
  // Try moving EITHER booking, not just the "conflicting attempt" - if class B's
  // grid is completely full (0 free periods) but class A still has room, this is
  // the only way a slot-move suggestion can be found at all.
  const suggestionsB = aiSuggestions(conflict.entryB, state).map((opt) => ({ ...opt, entry: conflict.entryB, cls: conflict.classB, subj: conflict.subjB }));
  const suggestionsA = aiSuggestions(conflict.entryA, state).map((opt) => ({ ...opt, entry: conflict.entryA, cls: conflict.classA, subj: conflict.subjA }));
  const suggestions = [...suggestionsB, ...suggestionsA].slice(0, 3);

  const altForB = conflict.type === 'faculty' ? alternateFacultyOptions(conflict.entryB, conflict.subjB, state) : [];
  const altForA = conflict.type === 'faculty' ? alternateFacultyOptions(conflict.entryA, conflict.subjA, state) : [];

  function applySlotMove(opt) {
    const next = {
      ...state,
      timetableEntries: state.timetableEntries.map((e) => (e.id === opt.entry.id ? { ...e, dayOrderId: opt.dayOrderId, periodId: opt.periodId } : e)),
    };
    actions.persist(actions.logActivity(next, 'Conflict resolved for ' + (conflict.fac?.name || 'faculty'), { entityType: 'timetable', entityId: conflict.classA?.departmentId || conflict.classB?.departmentId || null }));
    actions.toast('Conflict resolved.');
    onClose();
  }

  function applyFacultyReassign(entry, faculty) {
    const next = {
      ...state,
      timetableEntries: state.timetableEntries.map((e) => (e.id === entry.id ? { ...e, facultyId: faculty.id } : e)),
    };
    actions.persist(actions.logActivity(next, 'Conflict resolved \u2014 reassigned to ' + faculty.name, { entityType: 'timetable', entityId: conflict.classA?.departmentId || conflict.classB?.departmentId || null }));
    actions.toast('Conflict resolved.');
    onClose();
  }

  return (
    <div>
      <div className="mb-4 rounded-lg border p-3" style={{ borderColor: T.critical, background: T.criticalTint }}>
        <p className="text-sm font-semibold" style={{ color: T.critical }}>{conflict.message}</p>
      </div>

      <div className="mb-4 space-y-2 text-sm">
        <div className="rounded-lg border px-3 py-2" style={{ borderColor: T.border }}>
          <p className="text-xs font-semibold" style={{ color: T.muted }}>Existing assignment</p>
          <p style={{ color: T.ink }}>{classLabel(state, conflict.classA)} {'\u00b7'} {conflict.subjA?.name}</p>
        </div>
        <div className="rounded-lg border px-3 py-2" style={{ borderColor: T.critical, background: T.criticalTint }}>
          <p className="text-xs font-semibold" style={{ color: T.critical }}>Conflicting attempt</p>
          <p style={{ color: T.ink }}>{classLabel(state, conflict.classB)} {'\u00b7'} {conflict.subjB?.name}</p>
        </div>
      </div>

      <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold" style={{ color: T.ink }}><Sparkles size={14} color={T.primary} /> AI recommended resolutions</p>
      <p className="mb-3 text-xs" style={{ color: T.muted }}>Deterministic slot search {'\u2014'} ranks the nearest conflict-free Day Order and Period for either booking.</p>
      <div className="space-y-2">
        {suggestions.length === 0 && (
          <p className="text-sm" style={{ color: T.muted }}>
            No conflict-free slot available this week for either class {'\u2014'} both grids are full, so freeing a slot means swapping the faculty below instead.
          </p>
        )}
        {suggestions.map((opt, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border px-3 py-2.5" style={{ borderColor: T.border }}>
            <div>
              <p className="text-sm font-medium" style={{ color: T.ink }}>Move {classLabel(state, opt.cls)} {'\u00b7'} {opt.subj?.name} to {opt.dayLabel}, {opt.periodLabel}</p>
              <p className="text-xs" style={{ color: T.success }}>Conflict-free</p>
            </div>
            <PrimaryButton onClick={() => applySlotMove(opt)}>Apply</PrimaryButton>
          </div>
        ))}

        {(altForB.length > 0 || altForA.length > 0) ? (
          <>
            {altForB.map((f) => (
              <div key={'b-' + f.id} className="flex items-center justify-between rounded-lg border px-3 py-2.5" style={{ borderColor: T.border }}>
                <div>
                  <p className="text-sm font-medium" style={{ color: T.ink }}>Give {classLabel(state, conflict.classB)} {'\u00b7'} {conflict.subjB?.name} to {f.name}</p>
                  <p className="text-xs" style={{ color: T.success }}>Eligible {'\u00b7'} free at this slot</p>
                </div>
                <PrimaryButton onClick={() => applyFacultyReassign(conflict.entryB, f)}>Apply</PrimaryButton>
              </div>
            ))}
            {altForA.map((f) => (
              <div key={'a-' + f.id} className="flex items-center justify-between rounded-lg border px-3 py-2.5" style={{ borderColor: T.border }}>
                <div>
                  <p className="text-sm font-medium" style={{ color: T.ink }}>Give {classLabel(state, conflict.classA)} {'\u00b7'} {conflict.subjA?.name} to {f.name}</p>
                  <p className="text-xs" style={{ color: T.success }}>Eligible {'\u00b7'} free at this slot</p>
                </div>
                <PrimaryButton onClick={() => applyFacultyReassign(conflict.entryA, f)}>Apply</PrimaryButton>
              </div>
            ))}
          </>
        ) : (
          <div className="flex items-center justify-between rounded-lg border px-3 py-2.5" style={{ borderColor: T.border }}>
            <div>
              <p className="text-sm font-medium" style={{ color: T.ink }}>Assign another available faculty</p>
              <p className="text-xs" style={{ color: T.muted }}>No other eligible faculty is free at this slot {'\u2014'} edit the grid manually.</p>
            </div>
            <GhostButton
              onClick={() => {
                const target = conflict.classB || conflict.classA;
                onClose();
                if (target) actions.openClassForEdit(target);
                else actions.setPage('createTimetable');
              }}
            >
              Open grid
            </GhostButton>
          </div>
        )}
      </div>
    </div>
  );
}

// One class's full timetable, read-only, laid out exactly like the grid on Create Timetable:
// subject, teacher and room in every box, conflicts in red, plus a coverage strip.
function ClassTimetableCard({ state, conflicts, cs, onEdit }) {
  const periodSlots = state.periods.filter((p) => p.type === 'period');
  const entries = state.timetableEntries.filter((e) => e.classSectionId === cs.id);
  const room = cs.roomId ? state.classrooms.find((r) => r.id === cs.roomId) : null;
  const coverage = coverageForClass(state, cs);
  const required = coverage.filter((c) => !c.stray && !c.broken).reduce((s, c) => s + c.required, 0);
  const classConflicts = entries.filter((e) => conflicts.some((c) => c.entryA.id === e.id || c.entryB.id === e.id)).length;

  return (
    <Card className="overflow-x-auto p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="ts-display text-sm font-semibold" style={{ color: T.ink }}>{classLabel(state, cs)} timetable</p>
          <p className="text-xs" style={{ color: T.muted }}>
            {cs.batch ? 'Batch ' + cs.batch + ' \u00b7 ' : ''}Semester {cs.semester}{room ? ' \u00b7 Room ' + room.name : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={entries.length === 0 ? 'gray' : required && entries.length >= required ? 'success' : 'warn'}>
            {entries.length}{required ? ' / ' + required : ''} periods
          </Badge>
          {classConflicts > 0 && <Badge tone="critical">{classConflicts} in conflict</Badge>}
          {onEdit && <GhostButton icon={Pencil} onClick={() => onEdit(cs)}>Edit</GhostButton>}
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs" style={{ borderColor: T.border, color: T.muted }}>
          No periods scheduled yet. Build it in Create Timetable {'\u2192'} Auto-fill.
        </p>
      ) : (
        <>
          <table className="w-full min-w-[720px] table-fixed border-collapse text-xs">
            <thead>
              <tr>
                <th className="w-16 border p-2 text-left font-semibold" style={{ borderColor: T.border, color: T.muted, background: T.bg }}>Day order</th>
                {periodSlots.map((p) => (
                  <th key={p.id} className="border p-2 text-center font-semibold" style={{ borderColor: T.border, color: T.muted, background: T.bg }}>
                    <div>{p.label}</div>
                    <div className="ts-mono font-normal">{p.start}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.dayOrders.map((d) => (
                <tr key={d.id}>
                  <td className="border p-2 text-center" style={{ borderColor: T.border }}>
                    <div className="ts-mono font-bold" style={{ color: T.primary }}>{d.label}</div>
                    <div className="text-[10px]" style={{ color: T.muted }}>{String(d.actualDay || '').slice(0, 3)}</div>
                  </td>
                  {periodSlots.map((p) => {
                    const entry = entries.find((e) => e.dayOrderId === d.id && e.periodId === p.id);
                    const isConflicted = entry && conflicts.some((c) => c.entryA.id === entry.id || c.entryB.id === entry.id);
                    const subj = entry && state.subjects.find((s) => s.id === entry.subjectId);
                    const fac = entry && state.faculty.find((f) => f.id === entry.facultyId);
                    const rm = entry?.roomId ? state.classrooms.find((r) => r.id === entry.roomId) || state.labs.find((r) => r.id === entry.roomId) : null;
                    const broken = entry && (!subj || !fac);
                    return (
                      <td key={p.id} className="border p-1.5 align-top" style={{ borderColor: isConflicted || broken ? T.critical : T.border, background: isConflicted || broken ? T.criticalTint : 'transparent' }}>
                        {entry ? (
                          <div>
                            <p className="font-semibold" style={{ color: T.ink }}>{subj ? subj.name : 'Subject deleted'}</p>
                            <p style={{ color: T.muted }}>{fac ? fac.name : 'Faculty missing'}</p>
                            <p className="ts-mono" style={{ color: T.muted }}>{rm ? rm.name : '-'}</p>
                            {entry.type === 'lab' && <span className="mt-0.5 inline-block rounded px-1 text-[10px] font-semibold" style={{ background: T.primaryTint, color: T.primary }}>Lab</span>}
                          </div>
                        ) : (
                          <span style={{ color: T.muted }}>{'\u2014'}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {coverage.map((c) => {
              const bad = c.stray || c.broken || c.scheduled > c.required;
              const color = bad ? T.critical : c.scheduled === c.required ? T.success : T.warn;
              return (
                <span key={c.subjectId} className="rounded-full border px-2.5 py-0.5 text-xs" style={{ borderColor: color, color }}>
                  {c.broken ? c.name + ' \u00d7' + c.scheduled : c.stray ? c.name + ' \u00d7' + c.scheduled + ' (not in plan)' : c.name + ' ' + c.scheduled + '/' + c.required}
                </span>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

function TimetableOverview({ state, conflicts, initialDept = 'ALL', onEditClass }) {
  const [dept, setDept] = useState(initialDept);
  const [year, setYear] = useState('ALL');
  const [hideEmpty, setHideEmpty] = useState(false);
  useEffect(() => { setDept(initialDept); }, [initialDept]);

  // Every CLASS gets its own grid. (The old page merged all classes of a department into one
  // grid and showed only the first class found in each box, so with sections A and B - or two
  // years - most periods were hidden, and it never showed teacher or room.)
  const classes = state.classSections
    .filter((c) => (dept === 'ALL' || c.departmentId === dept) && (year === 'ALL' || c.year === year))
    .filter((c) => !hideEmpty || state.timetableEntries.some((e) => e.classSectionId === c.id))
    .sort((a, b) =>
      (state.departments.findIndex((d) => d.id === a.departmentId) - state.departments.findIndex((d) => d.id === b.departmentId))
      || (YEAR_OPTIONS.indexOf(a.year) - YEAR_OPTIONS.indexOf(b.year))
      || String(a.section).localeCompare(String(b.section)));
  const departments = state.departments.filter((d) => classes.some((c) => c.departmentId === d.id));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={dept} onChange={(e) => setDept(e.target.value)} className="w-48">
          <option value="ALL">All departments</option>
          {state.departments.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
        </Select>
        <Select value={year} onChange={(e) => setYear(e.target.value)} className="w-36">
          <option value="ALL">All years</option>
          {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y} year</option>)}
        </Select>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: T.muted }}>
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> hide classes with no timetable
        </label>
        <span className="text-xs" style={{ color: T.muted }}>{classes.length} class(es) {'\u00b7'} read-only view, edit in Create Timetable</span>
      </div>

      {classes.length === 0 && (
        <Card className="p-6 text-center text-sm" style={{ color: T.muted }}>
          No classes to show. Create classes in Master Data {'\u2192'} Departments, then build their timetables in Create Timetable.
        </Card>
      )}

      <div className="space-y-8">
        {departments.map((d) => (
          <section key={d.id}>
            <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>{d.id} {'\u2014'} {d.name}</p>
            <div className="space-y-5">
              {classes.filter((c) => c.departmentId === d.id).map((c) => (
                <ClassTimetableCard key={c.id} state={state} conflicts={conflicts} cs={c} onEdit={onEditClass} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function FacultyWorkload({ state }) {
  const rows = state.faculty.map((f) => {
    const load = state.subjects.filter((s) => s.facultyIds.includes(f.id)).reduce((sum, s) => sum + s.weeklyHours, 0);
    return { ...f, load, pct: Math.round((load / f.maxWeeklyHours) * 100) };
  });
  const chartData = rows.map((r) => ({ name: r.name.split(' ').slice(-1)[0], load: r.load, max: r.maxWeeklyHours }));

  return (
    <div>
      <Card className="mb-5 p-4">
        <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Faculty utilization</p>
        <div style={{ height: 240 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: T.muted }} axisLine={{ stroke: T.border }} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: T.muted }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid ' + T.border }} />
              <Bar dataKey="load" fill={T.primary} radius={[4, 4, 0, 0]} name="Assigned hours" />
              <Bar dataKey="max" fill="#D9E2ED" radius={[4, 4, 0, 0]} name="Max hours" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: T.bg }}>
              {['Faculty', 'Department', 'Assigned', 'Max', 'Utilization'].map((h) => (
                <th key={h} className="whitespace-nowrap px-4 py-2.5 text-left font-semibold" style={{ color: T.muted }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t" style={{ borderColor: T.border }}>
                <td className="px-4 py-2.5 font-medium" style={{ color: T.ink }}>{r.name}</td>
                <td className="px-4 py-2.5"><Badge>{r.departmentId}</Badge></td>
                <td className="px-4 py-2.5" style={{ color: T.ink }}>{r.load}</td>
                <td className="px-4 py-2.5" style={{ color: T.ink }}>{r.maxWeeklyHours}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-24"><ProgressBar value={r.load} max={r.maxWeeklyHours} color={r.pct > 100 ? T.critical : r.pct > 85 ? T.warn : T.primary} /></div>
                    <span className="ts-mono text-xs font-semibold" style={{ color: T.muted }}>{r.pct}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ScheduleAnalytics({ state, conflicts }) {
  const total = state.timetableEntries.length;
  const conflictRate = total ? Math.round((conflicts.length / total) * 100) : 0;
  const roomUtil = Math.round((total / (state.classrooms.length * state.dayOrders.length * 6 || 1)) * 100);
  const health = Math.max(0, 100 - conflicts.length * 4);

  const pieData = [
    { name: 'Faculty', value: conflicts.filter((c) => c.type === 'faculty').length },
    { name: 'Classroom', value: conflicts.filter((c) => c.type === 'classroom').length },
    { name: 'Class', value: conflicts.filter((c) => c.type === 'class').length },
  ].filter((d) => d.value > 0);
  const pieColors = [T.critical, T.warn, T.primary];

  return (
    <div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total entries" value={total} icon={Calendar} />
        <StatCard label="Conflict rate" value={conflictRate + '%'} icon={AlertTriangle} tone="critical" />
        <StatCard label="Room utilization" value={Math.min(100, roomUtil) + '%'} icon={MapPin} />
        <StatCard label="Schedule health" value={health + '%'} icon={TrendingUp} tone="success" />
      </div>

      <Card className="p-4">
        <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Conflicts by type</p>
        {pieData.length === 0 ? (
          <p className="py-8 text-center text-sm" style={{ color: T.muted }}>No conflicts to visualize {'\u2014'} the schedule is clean.</p>
        ) : (
          <div style={{ height: 220 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={3}>
                  {pieData.map((entry, i) => <Cell key={i} fill={pieColors[i % pieColors.length]} />)}
                </Pie>
                <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid ' + T.border }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>
    </div>
  );
}

function SettingsPage({ state, actions }) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetText, setResetText] = useState('');
  function exportData() {
    try {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'timesync-data.json';
      a.click();
      URL.revokeObjectURL(url);
      actions.toast('Data exported.');
    } catch (e) {
      actions.toast('Could not export the data. Try again.', 'critical');
    }
  }

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <p className="ts-display mb-1 text-sm font-semibold" style={{ color: T.ink }}>College information</p>
        <p className="mb-3 text-xs" style={{ color: T.muted }}>Edit this from Master Data {'\u2192'} College.</p>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between border-b py-2" style={{ borderColor: T.border }}><span style={{ color: T.muted }}>Name</span><span style={{ color: T.ink }}>{state.college.name}</span></div>
          <div className="flex justify-between border-b py-2" style={{ borderColor: T.border }}><span style={{ color: T.muted }}>Academic year</span><span style={{ color: T.ink }}>{state.college.academicYear}</span></div>
          <div className="flex justify-between py-2"><span style={{ color: T.muted }}>Working days</span><span style={{ color: T.ink }}>{state.college.workingDays}</span></div>
        </div>
      </Card>

      <Card className="p-5">
        <p className="ts-display mb-3 text-sm font-semibold" style={{ color: T.ink }}>Data management</p>
        <div className="flex flex-wrap items-center gap-2">
          <GhostButton icon={Download} onClick={exportData}>Export data</GhostButton>
          {!confirmingReset ? (
            <GhostButton icon={RefreshCw} tone="critical" onClick={() => setConfirmingReset(true)}>Reset demo data</GhostButton>
          ) : (
            <>
              <span className="text-xs font-medium" style={{ color: T.critical }}>
                This DELETES all real college data (departments, classes, faculty, subjects, timetables) from the database and replaces it with sample data. Type RESET to confirm.
              </span>
              <Input value={resetText} onChange={(e) => setResetText(e.target.value)} placeholder="RESET" className="w-28" />
              <PrimaryButton disabled={resetText !== 'RESET'} onClick={() => { actions.resetDemoData(); setConfirmingReset(false); setResetText(''); }}>Confirm reset</PrimaryButton>
              <GhostButton onClick={() => { setConfirmingReset(false); setResetText(''); }}>Cancel</GhostButton>
            </>
          )}
        </div>
      </Card>

      <Card className="p-5 lg:col-span-2">
        <p className="ts-display mb-1 text-sm font-semibold" style={{ color: T.ink }}>About Time Sync AI</p>
        <div className="space-y-2 text-sm" style={{ color: T.muted }}>
          <p>
            Your college{'\u2019'}s master data and timetables are kept in a shared cloud database (Supabase), so everyone sees the same
            timetable. Anyone can view; you must sign in to add, edit or delete.
          </p>
          <p>
            <strong style={{ color: T.ink }}>Auto-fill</strong> runs inside the app with no AI call. A teacher, room or class is never in two places in the same Day Order and Period
            (across every department), teacher availability and weekly-hour limits are respected, and labs get consecutive periods.
            Conflict detection is fully deterministic. Common subjects taught by the same teacher to different departments in one slot count as one combined class, not a clash.
          </p>
          <p>
            <strong style={{ color: T.ink }}>Change by comment</strong>: {isGrokConfigured()
              ? 'enabled. The AI only turns your sentence into a change; the app applies it and re-checks every rule.'
              : 'not enabled. Add VITE_GROK_API_KEY to turn it on (everything else works without it).'}
          </p>
          <p>PDF and PNG downloads are drawn directly with a canvas and jsPDF, so they don{'\u2019'}t depend on screenshots of the page.</p>
        </div>
      </Card>
    </div>
  );
}

const fontStyles = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
.ts-display { font-family: 'Space Grotesk', sans-serif; }
.ts-body { font-family: 'Inter', sans-serif; }
.ts-mono { font-family: 'IBM Plex Mono', monospace; }
.ts-body ::-webkit-scrollbar { width: 8px; height: 8px; }
.ts-body ::-webkit-scrollbar-thumb { background: #D7DCE3; border-radius: 4px; }
@media print {
  .no-print { display: none !important; }
  .print-only { display: block !important; }
}
.print-only { display: none; }
`;
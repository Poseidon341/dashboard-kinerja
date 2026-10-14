import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { 
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend 
} from 'recharts';
import { 
  LayoutDashboard, Building2, Search, Loader2, Award,
  LogOut, Lock, User, Landmark, Menu, ChevronLeft,
  Wallet, PieChart, Banknote, X, Filter, RotateCcw, ArrowUpDown,
  Calendar, Info, ArrowUpRight, ArrowDownRight, Layers, Eye, Users, Activity
} from 'lucide-react';
import { getRkaValFromRow } from './rkaLookup';
import { calculateCompleteDailyAverage } from './averageMetrics';

const namaBulanIndo = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

type AchievementTone = 'unavailable' | 'below-target' | 'near-target' | 'achieved';

const getAchievementTone = (percentage: number | null): AchievementTone => {
  if (percentage === null || !Number.isFinite(percentage)) return 'unavailable';
  if (percentage < 95) return 'below-target';
  if (percentage < 100) return 'near-target';
  return 'achieved';
};

const getAchievementTextClass = (tone: AchievementTone) => ({
  unavailable: 'text-slate-400',
  'below-target': 'text-rose-600',
  'near-target': 'text-amber-600',
  achieved: 'text-emerald-600'
}[tone]);

const getAchievementCellClass = (tone: AchievementTone) => ({
  unavailable: 'bg-slate-50',
  'below-target': 'bg-rose-100',
  'near-target': 'bg-amber-100',
  achieved: 'bg-emerald-100'
}[tone]);

const displayNumberFormatter = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const exactNumberFormatter = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 8 });
const tableAmountFormatter = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const threeDecimalFormatter = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const prognosisPercentFormatter = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RUPIAH_PER_MILIAR = 1_000_000_000;
const engineDataCache = new Map<string, any>();

const formatTruncatedNumber = (value: number, divisor = 1): string => {
  if (!Number.isFinite(value)) return '—';
  const thousandths = Math.trunc(Math.abs(value) / (divisor / 1000));
  const scaled = thousandths === 0 ? 0 : (value < 0 ? -1 : 1) * thousandths / 1000;
  return threeDecimalFormatter.format(scaled);
};

const formatCompactAmount = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${formatTruncatedNumber(value, 1e12)} T`;
  if (absolute >= 1e9) return `${formatTruncatedNumber(value, 1e9)} M`;
  if (absolute >= 1e6) return `${formatTruncatedNumber(value, 1e6)} Juta`;
  return formatTruncatedNumber(value);
};

const formatExactAmount = (value: number): string => exactNumberFormatter.format(value);
const formatFullAmount = (value: number): string => formatCompactAmount(value);
const formatPrognosisMiliar = (value: number): string => `${formatTruncatedNumber(value)} M`;
const calculatePrognosisAchievement = (
  actualRupiah: number | null | undefined,
  prognosisMiliar: number | null | undefined,
): number | null => {
  if (typeof actualRupiah !== 'number' || !Number.isFinite(actualRupiah)) return null;
  if (typeof prognosisMiliar !== 'number' || !Number.isFinite(prognosisMiliar) || prognosisMiliar <= 0) return null;
  return (actualRupiah / RUPIAH_PER_MILIAR / prognosisMiliar) * 100;
};

const REGION_MALANG_MAPPING: Record<string, string[]> = {
  "Area Jember": ["Banyuwangi", "Genteng", "Bondowoso", "Jember"],
  "Area Probolinggo": ["Situbondo", "Lumajang", "Probolinggo", "Pasuruan"],
  "Area Malang": ["Malang Kawi", "Malang Martadinata", "Malang Sutoyo", "Malang Soekarno Hatta", "Kepanjen", "Batu"],
  "Area Tulungagung": ["Pacitan", "Trenggalek", "Tulungagung", "Blitar"],
  "Area Kediri": ["Kediri", "Pare", "Nganjuk"],
  "Area Madiun": ["Madiun", "Magetan", "Ponorogo", "Ngawi"]
};

interface ChartItem {
  day: number; dec25: number | null; jun26: number | null; jul26: number | null; aug26: number | null; sep26: number | null; oct26: number | null;
}

type AuthStage = 'init' | 'login' | 'fetching_data' | 'dashboard' | 'error';
type ProductKey = 'dpk' | 'tabungan' | 'giro' | 'deposito';
type SortField = 'uker' | 'des25' | 'prev' | 'curr' | 'mtd_diff' | 'ytd_diff' | 'dtd_diff' | 'achievement';
type PrognosisRow = { row: number; values: unknown[] };
type PrognosisSheet = { rows: PrognosisRow[] };
type PrognosisPayload = { sheets: Record<string, PrognosisSheet> };

const PROGNOSIS_GROUP_BY_SEGMENT: Record<string, string> = {
  'Non-Wholesale (Ritel & Mikro)': 'NON WHOLESALE',
  Ritel: 'RITEL',
  Mikro: 'MIKRO',
};

const getBoOctoberCommitment = (
  payload: PrognosisPayload,
  groupLabel: string,
  product: ProductKey,
  selectedArea: string,
  selectedCabang: string,
  selectedUnit: string,
): number | null => {
  const sheet = payload.sheets['KOMITMEN BO'];
  if (!sheet) return null;

  const rows = sheet.rows;
  const groupTitle = rows.find(row => String(row.values[1] ?? '').trim().toUpperCase() === groupLabel);
  if (!groupTitle) return null;
  const groupEnd = rows.find(row => row.row > groupTitle.row && String(row.values[0] ?? '').trim().toUpperCase() === 'TOTAL');
  if (!groupEnd) return null;

  const periodHeader = rows.find(row => row.row === 2)?.values ?? [];
  const productHeader = rows.find(row => row.row === 3)?.values ?? [];
  const periodStart = periodHeader.findIndex(value => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase() === 'KOMITMEN POSISI 31 OKTOBER 2026');
  if (periodStart < 0) return null;
  const productLabel: Record<ProductKey, string> = { dpk: 'DPK', tabungan: 'TAB', deposito: 'DEPO', giro: 'GIRO' };
  let valueColumn = -1;
  for (let index = periodStart; index < Math.min(periodStart + 5, productHeader.length); index++) {
    if (String(productHeader[index] ?? '').trim().toUpperCase() === productLabel[product]) valueColumn = index;
  }
  if (valueColumn < 0) return null;

  const groupDetails = rows.filter(row => row.row > groupTitle.row && row.row < groupEnd.row && typeof row.values[0] === 'number');
  if (selectedArea === 'ALL' && selectedCabang === 'ALL' && selectedUnit === 'ALL') {
    const sourceValue = groupEnd.values[valueColumn];
    return typeof sourceValue === 'number' && Number.isFinite(sourceValue) ? sourceValue : null;
  }
  if (selectedUnit !== 'ALL' && selectedUnit !== 'KC') return null;

  const allowedBranches = selectedCabang !== 'ALL'
    ? new Set([selectedCabang.trim().toLocaleUpperCase('id-ID')])
    : selectedArea !== 'ALL'
      ? new Set((REGION_MALANG_MAPPING[selectedArea] || []).map(branch => branch.trim().toLocaleUpperCase('id-ID')))
      : null;
  const matchedRows = groupDetails.filter(row => {
    const branch = String(row.values[2] ?? '').trim().toLocaleUpperCase('id-ID');
    const office = String(row.values[1] ?? '').trim().toLocaleUpperCase('id-ID');
    return (!allowedBranches || allowedBranches.has(branch)) && (selectedUnit !== 'KC' || office.startsWith('KC '));
  });
  if (!matchedRows.length) return null;

  let total = 0;
  for (const row of matchedRows) {
    const value = row.values[valueColumn];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
};

type AppraisalSource = {
  period: string;
  year: number;
  month: string;
  type: 'RO' | 'KP';
  sheetName: string;
  sheetId: number;
  rowCount: number | null;
};

type AppraisalProfile = {
  pn: string;
  name: string;
  grade: string;
  role: string;
  unitCode: string;
  unitName: string | null;
  unitType: string | null;
  kcCode: string | null;
  kcName: string | null;
};

type AppraisalRecord = Record<string, unknown> & {
  PN: string | null;
  Score: number | null;
  Tier: string | null;
  targetAvailability: Record<string, 'available' | 'not_available'>;
};

type TierHistoryPoint = {
  period: string;
  label: string;
  tier: string | null;
  tierRank: number | null;
  score: string | null;
  hasRecord: boolean;
  matchCount: number;
};

type AppraisalMetric = {
  name: string;
  target: string;
  actual: string;
  realization: string;
  score: string;
  kind: 'amount' | 'count';
  accent: 'blue' | 'teal' | 'purple' | 'green' | 'amber';
};

const APPRAISAL_METRICS: AppraisalMetric[] = [
  { name: 'Daily Average Tabungan', target: 'Target Daily Average Tabungan', actual: 'Daily Average Tabungan', realization: '% Realisasi Daily Average Tabungan', score: 'Score Daily Average Tabungan', kind: 'amount', accent: 'blue' },
  { name: 'Posisi Saldo Tabungan', target: 'Target Posisi Saldo Tabungan', actual: 'Posisi Saldo Tabungan', realization: '% Realisasi Posisi Saldo Tabungan', score: 'Score Posisi Saldo Tabungan', kind: 'amount', accent: 'blue' },
  { name: 'Daily Average Giro Retail', target: 'Target Daily Average Giro Retail', actual: 'Daily Average Giro Retail', realization: '% Realisasi Daily Average Giro Retail', score: 'Score Daily Average Giro Retail', kind: 'amount', accent: 'teal' },
  { name: 'Daily Average DPK Retail', target: 'Target Daily Average DPK Retail', actual: 'Daily Average DPK Retail', realization: '% Realisasi Daily Average DPK Retail', score: 'Score Daily Average DPK Retail', kind: 'amount', accent: 'teal' },
  { name: 'New Account Payroll', target: 'Target New Account Payroll', actual: 'New Account Payroll', realization: '% Realisasi New Account Payroll', score: 'Score New Account Payroll', kind: 'count', accent: 'amber' },
  { name: 'Jumlah Merchant EDC Produktif', target: 'Target Jumlah Merchant EDC Produktif', actual: 'Jumlah Merchant EDC Produktif', realization: '% Realisasi Jumlah Merchant EDC Produktif', score: 'Score Jumlah Merchant EDC Produktif', kind: 'count', accent: 'purple' },
  { name: 'Jumlah Merchant QRIS Produktif', target: 'Target Jumlah Merchant QRIS Produktif', actual: 'Jumlah Merchant QRIS Produktif', realization: '% Realisasi Jumlah Merchant QRIS Produktif', score: 'Score Jumlah Merchant QRIS Produktif', kind: 'count', accent: 'purple' },
  { name: 'Daily Average CASA EDC Merchant', target: 'Target Daily Average CASA EDC Merchant', actual: 'Daily Average CASA EDC Merchant', realization: '% Realisasi Daily Average CASA EDC Merchant', score: 'Score Daily Average CASA EDC Merchant', kind: 'amount', accent: 'teal' },
  { name: 'Sales Volume Merchant EDC', target: 'Target Sales Volume Merchant EDC', actual: 'Sales Volume Merchant EDC', realization: '% Realisasi Sales Volume Merchant EDC', score: 'Score Sales Volume Merchant EDC', kind: 'amount', accent: 'purple' },
  { name: 'Sales Volume Merchant QRIS', target: 'Target Sales Volume Merchant QRIS', actual: 'Sales Volume Merchant QRIS', realization: '% Realisasi Sales Volume Merchant QRIS', score: 'Score Sales Volume Merchant QRIS', kind: 'amount', accent: 'purple' },
  { name: 'Jumlah User Aktif BRImo', target: 'Target Jumlah User Aktif BRImo', actual: 'Jumlah User Aktif BRImo', realization: '% Realisasi Jumlah User Aktif BRImo', score: 'Score Jumlah User Aktif BRImo', kind: 'count', accent: 'green' },
  { name: 'User Aktif QLOLA', target: 'Target User Aktif QLOLA', actual: 'User Aktif QLOLA', realization: '% Realisasi User Aktif QLOLA', score: 'Score User Aktif QLOLA', kind: 'count', accent: 'green' },
  { name: 'Product Holding', target: 'Target Product Holding', actual: 'Product Holding', realization: '% Realisasi Product Holding', score: 'Score Product Holding', kind: 'count', accent: 'amber' },
];
const KPI_ACCENT_STYLES: Record<AppraisalMetric['accent'], { line: string; score: string; scoreLabel: string; progress: string }> = {
  blue: { line: 'bg-blue-500', score: 'bg-blue-50 text-blue-800', scoreLabel: 'text-blue-600', progress: 'bg-blue-600' },
  teal: { line: 'bg-teal-500', score: 'bg-teal-50 text-teal-800', scoreLabel: 'text-teal-700', progress: 'bg-teal-600' },
  purple: { line: 'bg-violet-500', score: 'bg-violet-50 text-violet-800', scoreLabel: 'text-violet-700', progress: 'bg-violet-600' },
  green: { line: 'bg-emerald-500', score: 'bg-emerald-50 text-emerald-800', scoreLabel: 'text-emerald-700', progress: 'bg-emerald-600' },
  amber: { line: 'bg-amber-500', score: 'bg-amber-50 text-amber-900', scoreLabel: 'text-amber-700', progress: 'bg-amber-500' },
};

const appraisalSourceKey = (source: AppraisalSource) => `${source.period}|${source.type}`;
const APPRAISAL_CACHE_TTL_MS = 5 * 60 * 1000;
const parseRetryAfterMs = (value: string | null): number => {
  if (!value) return 5000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(1000, Math.min(60_000, delay)) : 5000;
};
type AppraisalGroupedData = { recordsByPn: Record<string, AppraisalRecord[]>; recordCount: number };
const appraisalRecordCache = new Map<string, AppraisalGroupedData & { cachedAt: number }>();
const appraisalDataRequestsInFlight = new Map<string, Promise<AppraisalGroupedData>>();
const isAppraisalSource = (value: unknown): value is AppraisalSource => {
  if (!value || typeof value !== 'object') return false;
  const source = value as Partial<AppraisalSource>;
  return typeof source.period === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(source.period)
    && (source.type === 'RO' || source.type === 'KP') && typeof source.sheetName === 'string';
};
const loadAppraisalSourceData = (source: AppraisalSource): Promise<AppraisalGroupedData> => {
  const sourceKey = appraisalSourceKey(source);
  const cached = appraisalRecordCache.get(sourceKey);
  if (cached && Date.now() - cached.cachedAt < APPRAISAL_CACHE_TTL_MS) {
    return Promise.resolve({ recordsByPn: cached.recordsByPn, recordCount: cached.recordCount });
  }
  const inFlight = appraisalDataRequestsInFlight.get(sourceKey);
  if (inFlight) return inFlight;

  const query = new URLSearchParams({ period: source.period, type: source.type, limit: '500', offset: '0' });
  const request = fetch(`/api/appraisal/data?${query.toString()}`)
    .then(async response => {
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
          ? payload.message : response.status === 429
            ? 'API Appraisal sedang membatasi permintaan. Tunggu sebentar sebelum mencoba lagi.'
            : `Gagal membaca data appraisal (HTTP ${response.status}).`;
        const error = new Error(message) as Error & { retryAfterMs?: number };
        if (response.status === 429) error.retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
        throw error;
      }
      if (!payload || typeof payload !== 'object' || !('records' in payload) || !Array.isArray(payload.records)) {
        throw new Error('Respons data appraisal tidak sesuai format.');
      }
      const body = payload as { records: unknown[]; recordCount?: unknown };
      const recordsByPn: Record<string, AppraisalRecord[]> = {};
      body.records.forEach(value => {
        if (!value || typeof value !== 'object') return;
        const record = value as AppraisalRecord;
        if (typeof record.PN !== 'string' || !record.PN.trim()) return;
        const pn = record.PN.trim();
        (recordsByPn[pn] ||= []).push(record);
      });
      const result = { recordsByPn, recordCount: typeof body.recordCount === 'number' ? body.recordCount : body.records.length };
      appraisalRecordCache.set(sourceKey, { ...result, cachedAt: Date.now() });
      return result;
    })
    .finally(() => appraisalDataRequestsInFlight.delete(sourceKey));
  appraisalDataRequestsInFlight.set(sourceKey, request);
  return request;
};
const formatAppraisalNumber = (value: unknown, kind: AppraisalMetric['kind'] = 'count') => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (kind !== 'amount') return displayNumberFormatter.format(value);
  if (value === 0) return '0';
  const absolute = Math.abs(value);
  if (absolute >= 1e9) {
    const scaled = value / 1e9;
    return `Rp${(Number.isInteger(scaled) ? displayNumberFormatter : tableAmountFormatter).format(scaled)} M`;
  }
  if (absolute >= 1e6) {
    const scaled = value / 1e6;
    return `Rp${(Number.isInteger(scaled) ? displayNumberFormatter : tableAmountFormatter).format(scaled)} jt`;
  }
  return `Rp${tableAmountFormatter.format(value)}`;
};
const formatAppraisalPercent = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${displayNumberFormatter.format(value * 100)}%`;
};

const appraisalTier = (record: AppraisalRecord | undefined): 1 | 2 | 3 | 4 | null => {
  const match = typeof record?.Tier === 'string' ? /^Tier\s*([1-4])$/i.exec(record.Tier.trim()) : null;
  return match ? Number(match[1]) as 1 | 2 | 3 | 4 : null;
};
const tierBadgeClass = (tier: number | null) => tier === 1 ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
  : tier === 2 ? 'border-teal-200 bg-teal-50 text-teal-800'
    : tier === 3 ? 'border-amber-200 bg-amber-50 text-amber-800'
      : tier === 4 ? 'border-rose-200 bg-rose-50 text-rose-800'
        : 'border-slate-200 bg-slate-100 text-slate-600';

const AppraisalRmList = React.memo(({ profiles, selectedPn, onSelect, tierByPn }: {
  profiles: AppraisalProfile[];
  selectedPn: string;
  onSelect: (pn: string) => void;
  tierByPn: Record<string, 1 | 2 | 3 | 4 | null>;
}) => (
  <section className="flex min-h-[320px] min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm xl:col-span-3 xl:h-[calc(100dvh-19rem)] xl:max-h-[760px] xl:min-h-[400px]">
    <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3.5"><div><h3 className="text-sm font-extrabold text-slate-900">Daftar RM</h3><p className="mt-0.5 text-[11px] text-slate-500">{profiles.length} profil sesuai filter</p></div><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-700"><Users size={17}/></span></div>
    <div className="min-h-0 max-h-[56vh] flex-1 divide-y divide-slate-100 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] xl:max-h-none">
      {profiles.map((person, index) => <React.Fragment key={person.pn}>{(index === 0 || profiles[index - 1].kcCode !== person.kcCode) && <h4 className="sticky top-0 z-[1] border-y border-slate-100 bg-slate-50/95 px-4 py-2 text-[10px] font-extrabold uppercase tracking-wide text-slate-600">{person.kcName ? `${person.kcName}${person.kcCode ? ` · ${person.kcCode}` : ''}` : 'KC belum terpetakan'}</h4>}<button onClick={() => onSelect(person.pn)} className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${selectedPn === person.pn ? 'bg-blue-50/80 ring-1 ring-inset ring-blue-100' : 'hover:bg-slate-50'}`}>
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-extrabold ${selectedPn === person.pn ? 'bg-[#123d70] text-white' : 'bg-slate-100 text-slate-600'}`}>{person.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()}</span>
        <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center justify-between gap-2"><span title={person.name} className="min-w-0 flex-1 truncate text-xs font-bold leading-4 text-slate-800">{person.name}</span><span className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-2 py-1 text-[9px] font-bold leading-none ${tierBadgeClass(tierByPn[person.pn] ?? null)}`}>{tierByPn[person.pn] ? `Tier ${tierByPn[person.pn]}` : 'Belum dinilai'}</span></span><span className="mt-1 block break-words text-[10px] leading-4 text-slate-500">PN {person.pn} · {person.role}</span><span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] leading-4 text-slate-400"><span className="rounded border border-slate-200 bg-white px-1 py-0.5 font-bold text-slate-600">{person.unitType || 'UNIT'}</span>{person.unitName || `Kode unit ${person.unitCode} belum terpetakan`}</span></span>
      </button></React.Fragment>)}
      {profiles.length === 0 && <p className="p-6 text-center text-xs text-slate-500">Tidak ada RM yang cocok dengan pencarian ini.</p>}
    </div>
  </section>
));

const AppraisalRmPhoto = React.memo(({ name, photoUrl }: { name: string; photoUrl?: string | null }) => {
  const [failed, setFailed] = useState(false);
  return <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 to-sky-100 text-xl font-extrabold tracking-wide text-[#174879]">
    {photoUrl && !failed
      ? <img src={photoUrl} alt={`Foto ${name}`} loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      : <User size={30} strokeWidth={1.5} aria-label={`Foto ${name} belum tersedia`} />}
  </div>;
});

const MENU_ITEMS = [
  { name: 'Dashboard Posisi Dana', icon: LayoutDashboard }, 
  { name: 'Dashboard Marginal', icon: BarChart3 },
  { name: 'Detail Unit Kerja', icon: Building2 },
  { name: 'Appraisal', icon: Award }
];

function BarChart3(props: any) {
  return <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>;
}

export const Dashboard = () => {
  const [authStage, setAuthStage] = useState<AuthStage>('init');
  const [loadError, setLoadError] = useState('');
  const [dbRmft, setDbRmft] = useState<any[]>([]);
  const [dbSegmen, setDbSegmen] = useState<any[]>([]);
  const loadedPositionScope = useRef('');
  const positionDataCache = useRef(new Map<string, any[]>());
  const [dbRka, setDbRka] = useState<any[]>([]); 
  const [dbUkerList, setDbUkerList] = useState<any[]>([]); 
  
  const [inputPN, setInputPN] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggedInUser, setLoggedInUser] = useState<any>(null);
  
  const [showProfile, setShowProfile] = useState(false); 
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const [activeMenu, setActiveMenu] = useState('Dashboard Posisi Dana'); 
  type FilterMenuKey = 'Dashboard Posisi Dana' | 'Dashboard Marginal' | 'Detail Unit Kerja' | 'Appraisal';
  type PageFilters = { area: string; cabang: string; unit: string; segmen: string; produk: string; periode: string };
  const initialPageFilters: PageFilters = {
    area: 'ALL', cabang: 'ALL', unit: 'ALL', segmen: 'Non-Wholesale (Ritel & Mikro)', produk: 'Semua Produk', periode: '2026-10-07'
  };
  const [pageFilters, setPageFilters] = useState<Record<FilterMenuKey, PageFilters>>({
    'Dashboard Posisi Dana': { ...initialPageFilters },
    'Dashboard Marginal': { ...initialPageFilters },
    'Detail Unit Kerja': { ...initialPageFilters },
    'Appraisal': { ...initialPageFilters }
  });
  const activeFilterMenu: FilterMenuKey = activeMenu === 'Dashboard Marginal' || activeMenu === 'Detail Unit Kerja' || activeMenu === 'Appraisal'
    ? activeMenu : 'Dashboard Posisi Dana';
  const updatePageFilter = (key: keyof PageFilters, value: string) => {
    setPageFilters(previous => ({
      ...previous,
      [activeFilterMenu]: { ...previous[activeFilterMenu], [key]: value }
    }));
  };
  const selectedArea = pageFilters[activeFilterMenu].area;
  const selectedCabang = pageFilters[activeFilterMenu].cabang;
  const selectedUnit = pageFilters[activeFilterMenu].unit;
  const selectedSegmen = pageFilters[activeFilterMenu].segmen;
  const selectedProduk = pageFilters[activeFilterMenu].produk;
  const selectedPeriode = pageFilters[activeFilterMenu].periode;
  const setSelectedArea = (value: string) => updatePageFilter('area', value);
  const setSelectedCabang = (value: string) => updatePageFilter('cabang', value);
  const setSelectedUnit = (value: string) => updatePageFilter('unit', value);
  const setSelectedSegmen = (value: string) => updatePageFilter('segmen', value);
  const setSelectedPeriode = (value: string) => updatePageFilter('periode', value);
  
  const [latestPeriode, setLatestPeriode] = useState('2026-10-07');
  const [searchUker, setSearchUker] = useState('');
  const [prognosisData, setPrognosisData] = useState<PrognosisPayload | null>(null);
  const [prognosisLoadState, setPrognosisLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let active = true;
    fetch('/api/funding/prognosis')
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((payload: { status: string; sheets: PrognosisPayload['sheets'] }) => {
        if (payload.status !== 'ok') throw new Error('Snapshot Prognosa MySQL belum tervalidasi.');
        if (!payload?.sheets?.['KOMITMEN BO'] || !Array.isArray(payload.sheets['KOMITMEN BO'].rows)) {
          throw new Error('Struktur sheet KOMITMEN BO tidak sesuai.');
        }
        if (!active) return;
        setPrognosisData(payload as PrognosisPayload);
        setPrognosisLoadState('ready');
      })
      .catch(() => {
        if (!active) return;
        setPrognosisData(null);
        setPrognosisLoadState('error');
      });
    return () => { active = false; };
  }, []);
  const prognosisGroup = PROGNOSIS_GROUP_BY_SEGMENT[selectedSegmen] || null;
  const prognosisValues = useMemo(() => {
    if (!prognosisData || !prognosisGroup) return { dpk: null, tabungan: null, deposito: null, giro: null };
    return {
      dpk: getBoOctoberCommitment(prognosisData, prognosisGroup, 'dpk', selectedArea, selectedCabang, selectedUnit),
      tabungan: getBoOctoberCommitment(prognosisData, prognosisGroup, 'tabungan', selectedArea, selectedCabang, selectedUnit),
      deposito: getBoOctoberCommitment(prognosisData, prognosisGroup, 'deposito', selectedArea, selectedCabang, selectedUnit),
      giro: getBoOctoberCommitment(prognosisData, prognosisGroup, 'giro', selectedArea, selectedCabang, selectedUnit),
    };
  }, [prognosisData, prognosisGroup, selectedArea, selectedCabang, selectedUnit]);
  const prognosisStatus = prognosisLoadState === 'loading'
    ? 'Memuat data Prognosa dari MySQL.'
    : prognosisLoadState === 'error'
      ? 'Data Prognosa MySQL gagal dibaca atau snapshot belum tervalidasi.'
      : !prognosisGroup
        ? 'Workbook tidak menyediakan kelompok Wholesale pada sheet KOMITMEN BO.'
        : selectedUnit !== 'ALL' && selectedUnit !== 'KC'
          ? `Workbook KOMITMEN BO tidak menyediakan rincian tipe unit ${selectedUnit}.`
          : 'Posisi aktual atau Prognosa Oktober tidak tersedia pada cakupan filter ini.';

  const [activeCard, setActiveCard] = useState<ProductKey>('dpk');
  const [chartViewMode, setChartViewMode] = useState<'grid' | 'focus'>('grid');
  
  const [averageTableProduct, setAverageTableProduct] = useState<ProductKey>('dpk');
  const [averageSearch, setAverageSearch] = useState('');
  const [averagePage, setAveragePage] = useState(1);
  const [averageSortAsc, setAverageSortAsc] = useState(true);
  const [appraisalSearch, setAppraisalSearch] = useState('');
  const [appraisalSearchDraft, setAppraisalSearchDraft] = useState('');
  const [appraisalKc, setAppraisalKc] = useState('ALL');
  const [appraisalRole, setAppraisalRole] = useState('ALL');
  const [selectedAppraisalPn, setSelectedAppraisalPn] = useState('');
  const [appraisalSources, setAppraisalSources] = useState<AppraisalSource[]>([]);
  const [appraisalSourcesLoaded, setAppraisalSourcesLoaded] = useState(false);
  const [selectedAppraisalSourceKey, setSelectedAppraisalSourceKey] = useState('');
  const [appraisalRecordsByPn, setAppraisalRecordsByPn] = useState<Record<string, AppraisalRecord[]>>({});
  const [appraisalDataSourceKey, setAppraisalDataSourceKey] = useState('');
  const [appraisalRecordCount, setAppraisalRecordCount] = useState(0);
  const [appraisalApiStatus, setAppraisalApiStatus] = useState<'idle' | 'loading-sources' | 'loading-data' | 'ready' | 'error'>('idle');
  const [appraisalApiError, setAppraisalApiError] = useState('');
  const [appraisalHistoryData, setAppraisalHistoryData] = useState<Record<string, Record<string, AppraisalRecord[]>>>({});
  const [appraisalHistoryStatus, setAppraisalHistoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [appraisalHistoryError, setAppraisalHistoryError] = useState('');
  const [appraisalRetryToken, setAppraisalRetryToken] = useState(0);
  const [appraisalRetryNotBefore, setAppraisalRetryNotBefore] = useState(0);
  const [appraisalRetryClock, setAppraisalRetryClock] = useState(() => Date.now());
  const appraisalSourcesRequestInFlight = useRef(false);
  const appraisalFetchBlockedAfterError = useRef(false);
  
  const [visibleLines, setVisibleLines] = useState<Record<string, boolean>>({ 
    dec25: true, jun26: true, jul26: true, aug26: true, sep26: true, oct26: true 
  });
  
  const [sortField, setSortField] = useState<SortField>('curr');
  const [sortAsc, setSortAsc] = useState(false);
  
  const [selectedUkerModal, setSelectedUkerModal] = useState<any>(null);

  useEffect(() => {
    if (authStage === 'init') {
      const fetchMysqlRecords = async (path: string) => {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
        const payload = await response.json();
        if (payload?.status !== 'ok' || !Array.isArray(payload.records)) throw new Error(`${path}: snapshot MySQL tidak tervalidasi`);
        return payload.records;
      };
      const sourcePaths = ['/api/funding/master/rmft', '/api/funding/rka', '/api/funding/master/offices'];
      Promise.all([
        ...sourcePaths.map(fetchMysqlRecords)
      ]).then(([rmftData, rkaData, ukerData]) => {
        if (!rmftData.length || !rkaData.length || !ukerData.length) {
          throw new Error('Satu atau lebih sumber data wajib kosong.');
        }
        setDbRmft(rmftData);
        setDbRka(rkaData);
        setDbUkerList(ukerData);
        setLoadError('');
        setAuthStage('login');
      }).catch(error => {
        console.error('Gagal memuat data awal:', error);
        setLoadError('Data profil, target, atau master unit gagal dimuat. Periksa koneksi lalu coba lagi.');
        setAuthStage('error');
      });
    }
  }, [authStage]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputPN.trim()) { setLoginError('PN tidak boleh kosong.'); return; }
    const user = dbRmft.find(u => {
      const pnKey = Object.keys(u).find(k => k.toUpperCase() === 'PN');
      return pnKey && u[pnKey].toString().trim() === inputPN.trim();
    });
    if (user) {
      setLoggedInUser(user);
      setLoginError('');
      setAuthStage('fetching_data');
    } else {
      setLoginError('PN tidak terdaftar di sistem. Hubungi Administrator.');
    }
  };

  const handleLogout = () => {
    setLoggedInUser(null);
    setInputPN('');
    setShowProfile(false);
    setLoadError('');
    setAuthStage('login');
  };

  useEffect(() => {
    if (authStage === 'fetching_data' || authStage === 'dashboard') {
      const scope = activeMenu === 'Detail Unit Kerja' ? 'mysql-detail' : 'mysql-position';
      if (loadedPositionScope.current === scope && dbSegmen.length > 0) return;
      const cachedData = positionDataCache.current.get(scope);
      if (cachedData) {
        setDbSegmen(cachedData);
        loadedPositionScope.current = scope;
        if (authStage === 'fetching_data') setAuthStage('dashboard');
        return;
      }
      let active = true;
      const sourcePath = scope === 'mysql-detail' ? '/api/funding/detail-unit/positions' : '/api/funding/positions';
      fetch(sourcePath)
        .then(async res => {
          if (!res.ok) throw new Error(`${sourcePath}: HTTP ${res.status}`);
          return res.json();
        })
        .then(payload => {
          const data = payload?.records;
          if (payload?.status !== 'ok' || !Number.isFinite(payload?.recordCount)) {
            throw new Error('API Posisi Dana tidak mengembalikan snapshot yang tervalidasi.');
          }
          if (!Array.isArray(data)) throw new Error(`${sourcePath}: format data tidak sesuai`);
          const cleanedData = data.map((row: any) => {
            const cabangOri = String(row['Nama Cabang'] ?? '').trim().toUpperCase();
            let cabang = cabangOri.replace(/\(KONSOLIDASI.*/g, '').replace(/-MDI.*/g, '').trim();

            const ukerOri = String(row['Nama Uker'] ?? '').trim().toUpperCase() || cabang;
            const kodeUkerOri = '';
            const segmen = String(row['Segmentasi BPR'] ?? '').toUpperCase().trim();
            const produk = String(row.Produk ?? '').toUpperCase().trim();
            
            const saldoStr = row.Saldo ?? '';
            let saldoNum = 0;
            if (typeof saldoStr === 'number') { saldoNum = saldoStr; } 
            else if (saldoStr) {
              let s = saldoStr.toString().trim().replace(/[^0-9-]/g, ''); 
              saldoNum = Number(s) || 0;
            }

            let y = 0, m = 0, d = 0;
            const posisiOri = String(row.Posisi ?? '');
            if (posisiOri) {
              const parts = posisiOri.split(/[-/]/);
              if (parts.length >= 3) {
                let p0 = parseInt(parts[0], 10), p1 = parseInt(parts[1], 10), p2 = parseInt(parts[2].substring(0, 4), 10);
                if (p2 > 2000) {
                  y = p2;
                  if (p0 > 12) { m = p1; d = p0; } else if (p1 > 12) { m = p0; d = p1; } else { m = p1; d = p0; }
                } else if (p0 > 2000) { y = p0; m = p1; d = p2; }
              }
            }

            return {
              cabang, ukerOri, kodeUkerOri, segmen, produk, saldo: saldoNum, y, m, d,
              isTab: produk.includes('TABUNGAN') || produk.includes('TAB'),
              isGir: produk.includes('GIRO'),
              isDep: produk.includes('DEPOSITO') || produk.includes('DEP'),
              isUkerKonsolidasi: ukerOri.includes('KONSOLIDASI')
            };
          });

          let maxTime = 0;
          let bestDate = '2026-10-07';
          cleanedData.forEach((row: any) => {
            if (row.y === 2026) {
              const t = new Date(row.y, row.m - 1, row.d).getTime();
              if (t > maxTime) {
                maxTime = t;
                bestDate = `${row.y}-${row.m.toString().padStart(2, '0')}-${row.d.toString().padStart(2, '0')}`;
              }
            }
          });

          if (!active) return;
          setLatestPeriode(bestDate);
          setPageFilters(previous => Object.fromEntries(
            Object.entries(previous).map(([menu, filters]) => [menu, filters.periode === initialPageFilters.periode ? { ...filters, periode: bestDate } : filters])
          ) as Record<FilterMenuKey, PageFilters>);
          engineDataCache.clear();
          setDbSegmen(cleanedData); 
          positionDataCache.current.set(scope, cleanedData);
          loadedPositionScope.current = scope;
          setLoadError('');
          if (authStage === 'fetching_data') setAuthStage('dashboard');
        })
        .catch(error => {
          if (!active) return;
          console.error('Gagal memuat data posisi:', error);
          setLoadError('Data posisi dari MySQL tidak dapat dimuat atau belum lolos validasi snapshot.');
          setAuthStage('error');
        });
      return () => { active = false; };
    }
  }, [authStage, activeMenu, dbSegmen.length]);

  const profileName = useMemo(() => {
    if (!loggedInUser) return '';
    const key = Object.keys(loggedInUser).find(k => ['NAMA', 'NAME'].includes(k.toUpperCase()));
    return key ? loggedInUser[key] : 'User';
  }, [loggedInUser]);

  const profileRole = useMemo(() => {
    if (!loggedInUser) return '';
    const key = Object.keys(loggedInUser).find(k => ['JABATAN', 'POSITION', 'ROLE'].includes(k.toUpperCase()));
    return key ? loggedInUser[key] : 'RMFT Reguler';
  }, [loggedInUser]);

  const profileCabang = useMemo(() => {
    if (!loggedInUser) return '';
    const key = Object.keys(loggedInUser).find(k => ['CABANG', 'UNIT', 'UKER'].includes(k.toUpperCase()));
    return key ? loggedInUser[key] : '-';
  }, [loggedInUser]);

  const availableCabang = useMemo(() => {
    if (selectedArea === 'ALL') return Object.values(REGION_MALANG_MAPPING).flat();
    return REGION_MALANG_MAPPING[selectedArea] || [];
  }, [selectedArea]);

  const availableMonths = useMemo(() => {
    const lastDays = new Map<string, number>();
    dbSegmen.forEach(row => {
      if (!row.y || !row.m || !row.d) return;
      const key = `${row.y}-${String(row.m).padStart(2, '0')}`;
      lastDays.set(key, Math.max(lastDays.get(key) || 0, row.d));
    });
    return lastDays;
  }, [dbSegmen]);

  const branchCodeByName = useMemo(() => {
    const index = new Map<string, string | null>();
    dbUkerList.forEach(item => {
      const name = String(item?.BRANCH ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
      const rawCode = item?.['BRANCH CODE'];
      const code = rawCode === null || rawCode === undefined || String(rawCode).trim() === '' ? null : String(rawCode).trim();
      if (!name) return;
      if (index.has(name) && index.get(name) !== code) index.set(name, null);
      else if (!index.has(name)) index.set(name, code);
    });
    return index;
  }, [dbUkerList]);

  const branchNameByCode = useMemo(() => {
    const index = new Map<string, string | null>();
    dbUkerList.forEach(item => {
      const code = String(item?.['BRANCH CODE'] ?? '').trim();
      const name = String(item?.BRANCH ?? '').trim();
      if (!code || !name) return;
      if (index.has(code) && index.get(code) !== name) index.set(code, null);
      else if (!index.has(code)) index.set(code, name);
    });
    return index;
  }, [dbUkerList]);

  const ukerByCode = useMemo(() => {
    const index = new Map<string, any>();
    dbUkerList.forEach(item => {
      const code = String(item?.['BRANCH CODE'] ?? '').trim();
      if (code) index.set(code, item);
    });
    return index;
  }, [dbUkerList]);

  const rmftProfiles = useMemo(() => dbRmft
    .filter(person => String(person?.Jabatan ?? '').toUpperCase().includes('RMFT'))
    .map(person => {
      const pn = String(person?.PN ?? '').trim();
      const unitCode = String(person?.['Kode Uker'] ?? '').trim();
      const unit = ukerByCode.get(unitCode);
      const mainBranchCode = String(unit?.['MAIN BRANCH CODE'] ?? '').trim();
      const unitType = String(unit?.['BRANCH TYPE'] ?? '').trim() || null;
      const kcCode = mainBranchCode || (unitType === 'KC' ? unitCode : '');
      const kc = kcCode ? ukerByCode.get(kcCode) : null;
      return {
        pn,
        name: String(person?.Nama ?? '').trim(),
        grade: String(person?.JG ?? '').trim(),
        role: String(person?.Jabatan ?? '').trim(),
        unitCode,
        unitName: branchNameByCode.get(unitCode) || null,
        unitType,
        kcCode: kc ? kcCode : null,
        kcName: String(kc?.BRANCH ?? '').trim() || null
      };
    })
    .filter((person, index, profiles) => person.pn && person.name && profiles.findIndex(candidate => candidate.pn === person.pn) === index), [dbRmft, branchNameByCode, ukerByCode]);

  const appraisalRoles = useMemo(() => [...new Set(rmftProfiles.map(person => person.role))].sort(), [rmftProfiles]);
  const appraisalKcs = useMemo(() => {
    const byCode = new Map<string, string>();
    dbUkerList.forEach(unit => {
      const code = String(unit?.['BRANCH CODE'] ?? '').trim();
      const name = String(unit?.BRANCH ?? '').trim();
      if (code && name && String(unit?.['BRANCH TYPE'] ?? '').trim().toUpperCase() === 'KC') byCode.set(code, name);
    });
    return [...byCode].map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'id-ID') || a.code.localeCompare(b.code));
  }, [dbUkerList]);
  const filteredAppraisalProfiles = useMemo(() => {
    const query = appraisalSearch.trim().toLocaleLowerCase('id-ID');
    return rmftProfiles.filter(person =>
      (!query || person.name.toLocaleLowerCase('id-ID').includes(query) || person.pn.includes(query))
      && (appraisalKc === 'ALL' || person.kcCode === appraisalKc)
      && (appraisalRole === 'ALL' || person.role === appraisalRole)
    ).slice().sort((a, b) => (a.kcName || 'KC belum terpetakan').localeCompare(b.kcName || 'KC belum terpetakan', 'id-ID')
      || (a.kcCode || '').localeCompare(b.kcCode || '') || (a.unitName || '').localeCompare(b.unitName || '', 'id-ID') || a.name.localeCompare(b.name, 'id-ID') || a.pn.localeCompare(b.pn));
  }, [rmftProfiles, appraisalSearch, appraisalKc, appraisalRole]);
  useEffect(() => {
    const timer = window.setTimeout(() => setAppraisalSearch(appraisalSearchDraft), 180);
    return () => window.clearTimeout(timer);
  }, [appraisalSearchDraft]);
  useEffect(() => {
    if (appraisalRetryNotBefore <= Date.now()) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setAppraisalRetryClock(now);
      if (now >= appraisalRetryNotBefore) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [appraisalRetryNotBefore]);
  const handleSelectAppraisalRm = useCallback((pn: string) => setSelectedAppraisalPn(pn), []);
  const selectedAppraisalRm = useMemo(() => rmftProfiles.find(person => person.pn === selectedAppraisalPn) || null, [rmftProfiles, selectedAppraisalPn]);
  const selectedAppraisalSource = useMemo(
    () => appraisalSources.find(source => appraisalSourceKey(source) === selectedAppraisalSourceKey) || null,
    [appraisalSources, selectedAppraisalSourceKey]
  );
  const appraisalHistorySources = useMemo(() => {
    if (!selectedAppraisalSource) return [];
    return appraisalSources
      .filter(source => source.type === selectedAppraisalSource.type && source.period <= selectedAppraisalSource.period)
      .slice()
      .sort((a, b) => a.period.localeCompare(b.period))
      .slice(-4);
  }, [appraisalSources, selectedAppraisalSource]);
  const appraisalTierHistory = useMemo<TierHistoryPoint[]>(() => {
    if (!selectedAppraisalPn || !selectedAppraisalSource) return [];
    return appraisalHistorySources.map(source => {
      const matchingRecords = appraisalHistoryData[appraisalSourceKey(source)]?.[selectedAppraisalPn] || [];
      const record = matchingRecords.length === 1 ? matchingRecords[0] : null;
      const tier = typeof record?.Tier === 'string' ? record.Tier.trim() : '';
      const tierMatch = /^Tier\s*([1-4])$/i.exec(tier);
      return {
        period: source.period,
        label: `${namaBulanIndo[Number(source.month) - 1]} ${source.year}`,
        tier: tier || null,
        tierRank: tierMatch ? Number(tierMatch[1]) : null,
        score: typeof record?.Score === 'number' && Number.isFinite(record.Score) ? formatAppraisalNumber(record.Score) : null,
        hasRecord: matchingRecords.length === 1,
        matchCount: matchingRecords.length,
      };
    });
  }, [appraisalHistoryData, appraisalHistorySources, selectedAppraisalPn, selectedAppraisalSource]);
  const selectedAppraisalRecords = selectedAppraisalSource && appraisalDataSourceKey === appraisalSourceKey(selectedAppraisalSource) && selectedAppraisalPn
    ? appraisalRecordsByPn[selectedAppraisalPn] || [] : [];
  const selectedAppraisalRecord = selectedAppraisalRecords.length === 1 ? selectedAppraisalRecords[0] : null;
  const appraisalDataReady = Boolean(selectedAppraisalSource && appraisalDataSourceKey === appraisalSourceKey(selectedAppraisalSource) && appraisalApiStatus === 'ready');
  const appraisalTierByPn = useMemo<Record<string, 1 | 2 | 3 | 4 | null>>(() => {
    const tiers: Record<string, 1 | 2 | 3 | 4 | null> = {};
    if (!appraisalDataReady) return tiers;
    rmftProfiles.forEach(profile => {
      const matches = appraisalRecordsByPn[profile.pn] || [];
      tiers[profile.pn] = matches.length === 1 ? appraisalTier(matches[0]) : null;
    });
    return tiers;
  }, [appraisalDataReady, appraisalRecordsByPn, rmftProfiles]);
  const sortedAppraisalProfiles = useMemo(() => filteredAppraisalProfiles.slice().sort((a, b) => {
    const kcSort = (a.kcName || 'KC belum terpetakan').localeCompare(b.kcName || 'KC belum terpetakan', 'id-ID')
      || (a.kcCode || '').localeCompare(b.kcCode || '');
    if (kcSort) return kcSort;
    const tierA = appraisalTierByPn[a.pn] ?? 5;
    const tierB = appraisalTierByPn[b.pn] ?? 5;
    return tierA - tierB || a.name.localeCompare(b.name, 'id-ID') || a.pn.localeCompare(b.pn);
  }), [filteredAppraisalProfiles, appraisalTierByPn]);
  const appraisalTierStats = useMemo(() => {
    if (!appraisalDataReady) return null;
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    filteredAppraisalProfiles.forEach(profile => {
      const tier = appraisalTierByPn[profile.pn];
      if (tier !== null && tier !== undefined) counts[tier] += 1;
    });
    const tieredCount = counts[1] + counts[2] + counts[3] + counts[4];
    const productive = counts[1] + counts[2];
    const unproductive = counts[3] + counts[4];
    return { total: filteredAppraisalProfiles.length, tiered: tieredCount, productive, unproductive,
      unassessed: filteredAppraisalProfiles.length - tieredCount,
      productivePct: tieredCount ? productive / tieredCount * 100 : null,
      unproductivePct: tieredCount ? unproductive / tieredCount * 100 : null };
  }, [appraisalDataReady, appraisalTierByPn, filteredAppraisalProfiles]);

  useEffect(() => {
    if (activeMenu !== 'Appraisal' || appraisalSourcesLoaded || appraisalSourcesRequestInFlight.current || appraisalFetchBlockedAfterError.current) return;
    appraisalSourcesRequestInFlight.current = true;
    setAppraisalSourcesLoaded(false);
    setAppraisalApiStatus('loading-sources');
    setAppraisalApiError('');
    fetch('/api/appraisal/sources')
      .then(async response => {
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          if (response.status === 429) setAppraisalRetryNotBefore(Date.now() + parseRetryAfterMs(response.headers.get('Retry-After')));
          const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
            ? payload.message : response.status === 429 ? 'API Appraisal sedang membatasi permintaan. Tunggu sebentar sebelum mencoba lagi.' : `Gagal membaca sumber appraisal (HTTP ${response.status}).`;
          throw new Error(message);
        }
        if (!payload || typeof payload !== 'object' || !('sources' in payload) || !Array.isArray(payload.sources)) {
          throw new Error('Respons daftar sumber appraisal tidak sesuai format.');
        }
        appraisalSourcesRequestInFlight.current = false;
        const sources = payload.sources.filter(isAppraisalSource);
        setAppraisalSources(sources);
        setSelectedAppraisalSourceKey(current => sources.some(source => appraisalSourceKey(source) === current)
          ? current : (sources[0] ? appraisalSourceKey(sources[0]) : ''));
        setAppraisalSourcesLoaded(true);
        if (sources.length === 0) setAppraisalApiStatus('ready');
      })
      .catch(error => {
        appraisalSourcesRequestInFlight.current = false;
        appraisalFetchBlockedAfterError.current = true;
        setAppraisalApiError(error instanceof Error ? error.message : 'Sumber appraisal tidak dapat dimuat.');
        setAppraisalApiStatus('error');
      });
  }, [activeMenu, appraisalSourcesLoaded, appraisalRetryToken]);

  useEffect(() => {
    if (activeMenu !== 'Appraisal' || !appraisalSourcesLoaded || !selectedAppraisalSource || appraisalFetchBlockedAfterError.current) return;
    const sourceKey = appraisalSourceKey(selectedAppraisalSource);
    let active = true;
    setAppraisalApiStatus('loading-data');
    setAppraisalApiError('');
    loadAppraisalSourceData(selectedAppraisalSource).then(result => {
        if (!active) return;
        setAppraisalRecordsByPn(result.recordsByPn);
        setAppraisalDataSourceKey(sourceKey);
        setAppraisalRecordCount(result.recordCount);
        setAppraisalApiStatus('ready');
      })
      .catch(error => {
        if (!active) return;
        const retryAfterMs = typeof error === 'object' && error && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
          ? error.retryAfterMs : null;
        if (retryAfterMs !== null) setAppraisalRetryNotBefore(Date.now() + retryAfterMs);
        appraisalFetchBlockedAfterError.current = true;
        setAppraisalApiError(error instanceof Error ? error.message : 'Data appraisal tidak dapat dimuat.');
        setAppraisalApiStatus('error');
      });
    return () => { active = false; };
  }, [activeMenu, appraisalSourcesLoaded, selectedAppraisalSource, appraisalRetryToken]);

  useEffect(() => {
    if (activeMenu !== 'Appraisal' || !selectedAppraisalPn || appraisalHistorySources.length === 0) return;
    let active = true;
    setAppraisalHistoryStatus('loading');
    setAppraisalHistoryError('');
    Promise.all(appraisalHistorySources.map(async source => ({
      key: appraisalSourceKey(source),
      result: await loadAppraisalSourceData(source),
    })))
      .then(results => {
        if (!active) return;
        setAppraisalHistoryData(current => ({
          ...current,
          ...Object.fromEntries(results.map(({ key, result }) => [key, result.recordsByPn])),
        }));
        setAppraisalHistoryStatus('ready');
      })
      .catch(error => {
        if (!active) return;
        const retryAfterMs = typeof error === 'object' && error && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number'
          ? error.retryAfterMs : null;
        if (retryAfterMs !== null) setAppraisalRetryNotBefore(Date.now() + retryAfterMs);
        setAppraisalHistoryError(error instanceof Error ? error.message : 'Riwayat appraisal tidak dapat dimuat.');
        setAppraisalHistoryStatus('error');
      });
    return () => { active = false; };
  }, [activeMenu, selectedAppraisalPn, appraisalHistorySources, appraisalRetryToken]);

  const rkaRowsByCodeCategory = useMemo(() => {
    const index = new Map<string, any[]>();
    dbRka.forEach(row => {
      const code = String(row?.['KODE UKER'] ?? '').trim();
      const category = String(row?.['MATA ANGGARAN'] ?? '').trim().toUpperCase();
      if (!code || !category) return;
      const key = `${code}\u0000${category}`;
      const matches = index.get(key);
      if (matches) matches.push(row);
      else index.set(key, [row]);
    });
    return index;
  }, [dbRka]);

  const handleResetFilters = () => {
    setPageFilters(previous => ({ ...previous, [activeFilterMenu]: { ...initialPageFilters, periode: latestPeriode } }));
    if (activeFilterMenu === 'Detail Unit Kerja') setSearchUker('');
    if (activeFilterMenu === 'Dashboard Marginal') {
      setAverageSearch('');
      setAverageTableProduct('dpk');
      setAveragePage(1);
    }
  };

  const formatUangDetail = (num: number) => {
    return formatCompactAmount(num);
  }

  const formatUangDelta = (num: number) => formatCompactAmount(num);
  const formatUangMaybe = (num: number | null | undefined) => num === null || num === undefined ? '—' : formatUangDetail(num);

  // Resolve unit names through the branch master and use the branch's own code.
  // MAIN BRANCH CODE identifies the parent KC and must not be used for a unit.
  const findKodeUker = (namaUker: string, kodeOri: any) => {
    const suppliedCode = kodeOri === null || kodeOri === undefined ? '' : String(kodeOri).trim();
    if (suppliedCode && ukerByCode.has(suppliedCode)) return suppliedCode;
    if (!namaUker || !dbUkerList.length) {
      return suppliedCode || null;
    }
    const cleanNama = String(namaUker).toUpperCase().replace(/\s+/g, ' ').trim();
    return branchCodeByName.get(cleanNama) ?? null;
  }

  const isDetailDataMode = activeMenu === 'Detail Unit Kerja';
  const isMarginalDataMode = activeMenu === 'Dashboard Marginal';
  const dataArea = isMarginalDataMode ? 'ALL' : selectedArea;
  const dataCabang = isMarginalDataMode ? 'ALL' : selectedCabang;
  const dataUnit = isMarginalDataMode ? 'ALL' : selectedUnit;
  const engineData = useMemo(() => {
    const cacheKey = JSON.stringify([dataArea, dataCabang, dataUnit, selectedSegmen, selectedProduk, selectedPeriode, isDetailDataMode, isMarginalDataMode]);
    const cachedResult = engineDataCache.get(cacheKey);
    if (cachedResult) return cachedResult;
    if (!dbSegmen || dbSegmen.length === 0) {
      return { stats: { dpk: {val:null,dtd:null,mtd:null,mtm:null,ytd:null,snapshotDay:null}, tabungan: {val:null,dtd:null,mtd:null,mtm:null,ytd:null,snapshotDay:null}, giro: {val:null,dtd:null,mtd:null,mtm:null,ytd:null,snapshotDay:null}, deposito: {val:null,dtd:null,mtd:null,mtm:null,ytd:null,snapshotDay:null} }, charts: { tabungan: [], giro: [], deposito: [], dpk: [] }, branchList: [], ukerList: [], averages: { tabungan: null, giro: null, deposito: null, dpk: null, historical: { tabungan: null, giro: null, deposito: null, dpk: null }, movement: { dpk: { dtd: null, mtd: null, ytd: null }, tabungan: { dtd: null, mtd: null, ytd: null }, giro: { dtd: null, mtd: null, ytd: null }, deposito: { dtd: null, mtd: null, ytd: null } }, currD: 0, currentLastDay: { dpk: 0, tabungan: 0, giro: 0, deposito: 0 }, daysInMonth: 0, snapshotDays: { dpk: 0, tabungan: 0, giro: 0, deposito: 0 }, currentDatesAvailable: { dpk: 0, tabungan: 0, giro: 0, deposito: 0 }, monthlyDatesAvailable: { dpk: 0, tabungan: 0, giro: 0, deposito: 0 }, dailyTotals: { dpk: new Map(), tabungan: new Map(), giro: new Map(), deposito: new Map() } }, rawSummary: { tabungan: [], giro: [], deposito: [], dpk: [] }, effectiveD: null, effectivePrevD: null };
    }

    let currY = 2026, currM = 10, currD = 7;
    if (selectedPeriode) {
      const parts = selectedPeriode.split(/[-/]/);
      if (parts.length >= 3) {
        let p0 = parseInt(parts[0], 10), p1 = parseInt(parts[1], 10), p2 = parseInt(parts[2].substring(0, 4), 10);
        if (p2 > 2000) { if (p0 > 12) { currY = p2; currM = p1; currD = p0; } else if (p1 > 12) { currY = p2; currM = p0; currD = p1; } else { currY = p2; currM = p1; currD = p0; } } 
        else if (p0 > 2000) { currY = p0; currM = p1; currD = p2; }
      }
    }
    let prevM = currM - 1, prevY = currY; if (prevM <= 0) { prevM += 12; prevY -= 1; }

    const validRows: any[] = [];
    let effectiveD = 0; let effectivePrevD = 0;
    const isDetailMode = isDetailDataMode;

    dbSegmen.forEach(row => {
      let passCabang = true;
      if (dataCabang !== 'ALL') passCabang = row.cabang.includes(dataCabang.toUpperCase());
      else if (dataArea !== 'ALL') passCabang = (REGION_MALANG_MAPPING[dataArea] || []).some(c => row.cabang.includes(c.toUpperCase()));

      let passSegmen = false; let passProduk = true;
      if (isDetailMode) { passSegmen = row.segmen.includes('MIKRO'); passProduk = row.isTab; } 
      else {
        const sourceSegment = row.segmen.trim().toUpperCase();
        if (selectedSegmen === 'Non-Wholesale (Ritel & Mikro)') passSegmen = sourceSegment === 'RITEL' || sourceSegment === 'MIKRO';
        else if (selectedSegmen === 'Ritel') passSegmen = sourceSegment === 'RITEL';
        else if (selectedSegmen === 'Mikro') passSegmen = sourceSegment === 'MIKRO';
        else if (selectedSegmen === 'Wholesale') passSegmen = sourceSegment === 'KORPORASI';
        if (!isMarginalDataMode && selectedProduk !== 'Semua Produk') {
          if (selectedProduk === 'Tabungan') passProduk = row.isTab; else if (selectedProduk === 'Giro') passProduk = row.isGir; else if (selectedProduk === 'Deposito') passProduk = row.isDep;
        }
      }
      let passUnit = true;
      if (dataUnit !== 'ALL') {
        const uUpper = row.ukerOri.toUpperCase();
        if (dataUnit === 'KC') passUnit = uUpper.startsWith('KC '); else if (dataUnit === 'KCP') passUnit = uUpper.includes('KCP'); else if (dataUnit === 'KK') passUnit = uUpper.includes('KK'); else if (dataUnit === 'UNIT') passUnit = uUpper.includes('UNIT');
      }

      if (passCabang && passSegmen && passProduk && passUnit) {
        validRows.push(row);
        if (row.y === currY && row.m === currM && row.d <= currD) { if (row.d > effectiveD) effectiveD = row.d; }
        if (row.y === prevY && row.m === prevM) { if (row.d > effectivePrevD) effectivePrevD = row.d; }
      }
    });

    if (effectiveD === 0) effectiveD = null as any;
    if (effectivePrevD === 0) effectivePrevD = null as any;
    const d1Y = effectiveD && effectiveD > 1 ? currY : prevY;
    const d1M = effectiveD && effectiveD > 1 ? currM : prevM;
    const d1D = effectiveD && effectiveD > 1 ? effectiveD - 1 : effectivePrevD;

    const branchMap: Record<string, any> = {}; const ukerMap: Record<string, any> = {};
    const currentSnapshotDays = { dpk: new Set<number>(), tabungan: new Set<number>(), giro: new Set<number>(), deposito: new Set<number>() };
    const dec25Snapshots = { tabungan: false, giro: false, deposito: false };
    const initChart = (): ChartItem[] => Array.from({ length: 31 }, (_, i) => ({ day: i + 1, dec25: null, jun26: null, jul26: null, aug26: null, sep26: null, oct26: null }));
    const cTab = initChart(), cGir = initChart(), cDep = initChart(), cDpk = initChart();
    let dec25Tab = 0, dec25Gir = 0, dec25Dep = 0; let sumDec25Tab = 0, sumDec25Gir = 0, sumDec25Dep = 0; let sumSep1Tab = 0, sumSep1Gir = 0, sumSep1Dep = 0; let sumSep30Tab = 0, sumSep30Gir = 0, sumSep30Dep = 0;

    validRows.forEach(row => {
      if (row.isUkerKonsolidasi) return;
      const cleanUker = row.ukerOri.trim(); const ukerKey = `${row.cabang}-${cleanUker}`;
      if (!ukerMap[ukerKey]) { ukerMap[ukerKey] = { uker: cleanUker, cabang: row.cabang, kode_uker: row.kodeUkerOri, curr_tab: 0, curr_gir: 0, curr_dep: 0, curr_dpk: 0, prev_dpk: 0, des25_dpk: 0, prev: 0, des25: 0, curr: 0, d_min_1: 0, has_curr: false, has_curr_tab: false, has_curr_gir: false, has_curr_dep: false, has_prev: false, has_d_min_1: false, has_des25: false, sum_tab: 0, sum_gir: 0, sum_dep: 0, sum_dpk: 0 }; }
      ukerMap[ukerKey].posByDay ||= { dpk: {}, tabungan: {}, giro: {}, deposito: {} };
      ukerMap[ukerKey].monthlyPosByDay ||= { dpk: {}, tabungan: {}, giro: {}, deposito: {} };
      ukerMap[ukerKey].dailySnapshots ||= {};
      ukerMap[ukerKey].has_sum_dpk ??= false;
      ukerMap[ukerKey].has_sum_tab ??= false;
      ukerMap[ukerKey].has_sum_gir ??= false;
      ukerMap[ukerKey].has_sum_dep ??= false;
      if (!branchMap[row.cabang]) branchMap[row.cabang] = { name: row.cabang, tabungan: 0, giro: 0, deposito: 0, dpk: 0, sum_tab: 0, sum_gir: 0, sum_dep: 0, sum_dpk: 0 };

      if (row.y > 0 && row.m > 0 && row.d > 0) {
        const dateKey = `${row.y}-${String(row.m).padStart(2, '0')}-${String(row.d).padStart(2, '0')}`;
        const snapshots = ukerMap[ukerKey].dailySnapshots;
        snapshots[dateKey] ||= {};
        const addSnapshot = (key: ProductKey) => { snapshots[dateKey][key] = (snapshots[dateKey][key] || 0) + row.saldo; };
        addSnapshot('dpk');
        if (row.isTab) addSnapshot('tabungan');
        if (row.isGir) addSnapshot('giro');
        if (row.isDep) addSnapshot('deposito');
      }

      if (row.y === currY && row.m === currM) {
        const addMonthlyDay = (key: ProductKey) => {
          const daily = ukerMap[ukerKey].monthlyPosByDay[key];
          daily[row.d] = (daily[row.d] || 0) + row.saldo;
        };
        addMonthlyDay('dpk');
        if (row.isTab) addMonthlyDay('tabungan');
        if (row.isGir) addMonthlyDay('giro');
        if (row.isDep) addMonthlyDay('deposito');
      }

      if (row.y === 2025 && row.m === 12 && row.d === 31) {
        ukerMap[ukerKey].has_des25 = true;
        ukerMap[ukerKey].des25_dpk += row.saldo; ukerMap[ukerKey].des25 += row.saldo;
        if (row.isTab) dec25Snapshots.tabungan = true;
        if (row.isGir) dec25Snapshots.giro = true;
        if (row.isDep) dec25Snapshots.deposito = true;
        if (row.isTab) sumDec25Tab += row.saldo; if (row.isGir) sumDec25Gir += row.saldo; if (row.isDep) sumDec25Dep += row.saldo;
      }
      if (row.y === prevY && row.m === prevM && row.d === effectivePrevD) { ukerMap[ukerKey].has_prev = true; ukerMap[ukerKey].prev_dpk += row.saldo; ukerMap[ukerKey].prev += row.saldo; }
      if (row.y === 2026 && row.m === 9 && row.d === 1) { if (row.isTab) sumSep1Tab += row.saldo; if (row.isGir) sumSep1Gir += row.saldo; if (row.isDep) sumSep1Dep += row.saldo; }
      if (row.y === 2026 && row.m === 9 && row.d === 30) { if (row.isTab) sumSep30Tab += row.saldo; if (row.isGir) sumSep30Gir += row.saldo; if (row.isDep) sumSep30Dep += row.saldo; }

      if (row.y === currY && row.m === currM && row.d <= currD) {
        currentSnapshotDays.dpk.add(row.d);
        if (row.isTab) currentSnapshotDays.tabungan.add(row.d);
        if (row.isGir) currentSnapshotDays.giro.add(row.d);
        if (row.isDep) currentSnapshotDays.deposito.add(row.d);
        ukerMap[ukerKey].sum_dpk += row.saldo; branchMap[row.cabang].sum_dpk += row.saldo;
        ukerMap[ukerKey].has_sum_dpk = true;
        ukerMap[ukerKey].posByDay.dpk[row.d] = (ukerMap[ukerKey].posByDay.dpk[row.d] || 0) + row.saldo;
        if (row.isTab) { ukerMap[ukerKey].has_sum_tab = true; ukerMap[ukerKey].sum_tab += row.saldo; branchMap[row.cabang].sum_tab += row.saldo; ukerMap[ukerKey].posByDay.tabungan[row.d] = (ukerMap[ukerKey].posByDay.tabungan[row.d] || 0) + row.saldo; }
        if (row.isGir) { ukerMap[ukerKey].has_sum_gir = true; ukerMap[ukerKey].sum_gir += row.saldo; branchMap[row.cabang].sum_gir += row.saldo; ukerMap[ukerKey].posByDay.giro[row.d] = (ukerMap[ukerKey].posByDay.giro[row.d] || 0) + row.saldo; }
        if (row.isDep) { ukerMap[ukerKey].has_sum_dep = true; ukerMap[ukerKey].sum_dep += row.saldo; branchMap[row.cabang].sum_dep += row.saldo; ukerMap[ukerKey].posByDay.deposito[row.d] = (ukerMap[ukerKey].posByDay.deposito[row.d] || 0) + row.saldo; }

        if (row.d === effectiveD) {
          ukerMap[ukerKey].has_curr = true;
          ukerMap[ukerKey].curr_dpk += row.saldo; branchMap[row.cabang].dpk += row.saldo; ukerMap[ukerKey].curr += row.saldo;
          if (row.isTab) { ukerMap[ukerKey].has_curr_tab = true; ukerMap[ukerKey].curr_tab += row.saldo; branchMap[row.cabang].tabungan += row.saldo; }
          if (row.isGir) { ukerMap[ukerKey].has_curr_gir = true; ukerMap[ukerKey].curr_gir += row.saldo; branchMap[row.cabang].giro += row.saldo; }
          if (row.isDep) { ukerMap[ukerKey].has_curr_dep = true; ukerMap[ukerKey].curr_dep += row.saldo; branchMap[row.cabang].deposito += row.saldo; }
        }
      }
      if (row.y === d1Y && row.m === d1M && row.d === d1D) { ukerMap[ukerKey].has_d_min_1 = true; ukerMap[ukerKey].d_min_1 += row.saldo; }

      if (row.y === 2025 && row.m === 12 && row.d === 31) { if (row.isTab) dec25Tab += row.saldo; else if (row.isGir) dec25Gir += row.saldo; else if (row.isDep) dec25Dep += row.saldo; } 
      else if (row.y === 2026 && row.d >= 1 && row.d <= 31) {
        const idx = row.d - 1;
        if (idx >= 0 && idx < 31) {
          if (row.m === 6) { if (row.isTab) cTab[idx].jun26 = (cTab[idx].jun26 || 0) + row.saldo; else if (row.isGir) cGir[idx].jun26 = (cGir[idx].jun26 || 0) + row.saldo; else if (row.isDep) cDep[idx].jun26 = (cDep[idx].jun26 || 0) + row.saldo; }
          else if (row.m === 7) { if (row.isTab) cTab[idx].jul26 = (cTab[idx].jul26 || 0) + row.saldo; else if (row.isGir) cGir[idx].jul26 = (cGir[idx].jul26 || 0) + row.saldo; else if (row.isDep) cDep[idx].jul26 = (cDep[idx].jul26 || 0) + row.saldo; }
          else if (row.m === 8) { if (row.isTab) cTab[idx].aug26 = (cTab[idx].aug26 || 0) + row.saldo; else if (row.isGir) cGir[idx].aug26 = (cGir[idx].aug26 || 0) + row.saldo; else if (row.isDep) cDep[idx].aug26 = (cDep[idx].aug26 || 0) + row.saldo; }
          else if (row.m === 9) { if (row.isTab) cTab[idx].sep26 = (cTab[idx].sep26 || 0) + row.saldo; else if (row.isGir) cGir[idx].sep26 = (cGir[idx].sep26 || 0) + row.saldo; else if (row.isDep) cDep[idx].sep26 = (cDep[idx].sep26 || 0) + row.saldo; }
          else if (row.m === 10) { if (row.isTab) cTab[idx].oct26 = (cTab[idx].oct26 || 0) + row.saldo; else if (row.isGir) cGir[idx].oct26 = (cGir[idx].oct26 || 0) + row.saldo; else if (row.isDep) cDep[idx].oct26 = (cDep[idx].oct26 || 0) + row.saldo; }
        }
      }
    });

    const rawTab = JSON.parse(JSON.stringify(cTab)); const rawGir = JSON.parse(JSON.stringify(cGir)); const rawDep = JSON.parse(JSON.stringify(cDep)); const rawDpk = initChart();
    const hasDec25Dpk = selectedProduk === 'Tabungan' ? dec25Snapshots.tabungan
      : selectedProduk === 'Giro' ? dec25Snapshots.giro
      : selectedProduk === 'Deposito' ? dec25Snapshots.deposito
      : dec25Snapshots.tabungan && dec25Snapshots.giro && dec25Snapshots.deposito;
    for (let i = 0; i < 31; i++) {
      rawTab[i].dec25 = dec25Snapshots.tabungan ? dec25Tab : null;
      rawGir[i].dec25 = dec25Snapshots.giro ? dec25Gir : null;
      rawDep[i].dec25 = dec25Snapshots.deposito ? dec25Dep : null;
      rawDpk[i].dec25 = hasDec25Dpk ? dec25Tab + dec25Gir + dec25Dep : null;
    }
    
    for (let i = 0; i < 31; i++) {
      rawDpk[i].jun26 = (rawTab[i].jun26 !== null || rawGir[i].jun26 !== null || rawDep[i].jun26 !== null) ? (rawTab[i].jun26 || 0) + (rawGir[i].jun26 || 0) + (rawDep[i].jun26 || 0) : null;
      rawDpk[i].jul26 = (rawTab[i].jul26 !== null || rawGir[i].jul26 !== null || rawDep[i].jul26 !== null) ? (rawTab[i].jul26 || 0) + (rawGir[i].jul26 || 0) + (rawDep[i].jul26 || 0) : null;
      rawDpk[i].aug26 = (rawTab[i].aug26 !== null || rawGir[i].aug26 !== null || rawDep[i].aug26 !== null) ? (rawTab[i].aug26 || 0) + (rawGir[i].aug26 || 0) + (rawDep[i].aug26 || 0) : null;
      rawDpk[i].sep26 = (rawTab[i].sep26 !== null || rawGir[i].sep26 !== null || rawDep[i].sep26 !== null) ? (rawTab[i].sep26 || 0) + (rawGir[i].sep26 || 0) + (rawDep[i].sep26 || 0) : null;
      rawDpk[i].oct26 = (rawTab[i].oct26 !== null || rawGir[i].oct26 !== null || rawDep[i].oct26 !== null) ? (rawTab[i].oct26 || 0) + (rawGir[i].oct26 || 0) + (rawDep[i].oct26 || 0) : null;
    }

    for (let i = 0; i < 31; i++) {
      cTab[i].dec25 = dec25Snapshots.tabungan ? dec25Tab : null; cGir[i].dec25 = dec25Snapshots.giro ? dec25Gir : null; cDep[i].dec25 = dec25Snapshots.deposito ? dec25Dep : null; cDpk[i].dec25 = hasDec25Dpk ? dec25Tab + dec25Gir + dec25Dep : null;
      if (i > 0) {
        if (cTab[i].jun26 === null) cTab[i].jun26 = cTab[i-1].jun26; if (cTab[i].jul26 === null) cTab[i].jul26 = cTab[i-1].jul26; if (cTab[i].aug26 === null) cTab[i].aug26 = cTab[i-1].aug26; if (cTab[i].sep26 === null) cTab[i].sep26 = cTab[i-1].sep26; if (cTab[i].oct26 === null) cTab[i].oct26 = cTab[i-1].oct26;
        if (cGir[i].jun26 === null) cGir[i].jun26 = cGir[i-1].jun26; if (cGir[i].jul26 === null) cGir[i].jul26 = cGir[i-1].jul26; if (cGir[i].aug26 === null) cGir[i].aug26 = cGir[i-1].aug26; if (cGir[i].sep26 === null) cGir[i].sep26 = cGir[i-1].sep26; if (cGir[i].oct26 === null) cGir[i].oct26 = cGir[i-1].oct26;
        if (cDep[i].jun26 === null) cDep[i].jun26 = cDep[i-1].jun26; if (cDep[i].jul26 === null) cDep[i].jul26 = cDep[i-1].jul26; if (cDep[i].aug26 === null) cDep[i].aug26 = cDep[i-1].aug26; if (cDep[i].sep26 === null) cDep[i].sep26 = cDep[i-1].sep26; if (cDep[i].oct26 === null) cDep[i].oct26 = cDep[i-1].oct26;
      }
      const currentDay = i + 1;
      if (currM < 6 || (currM === 6 && currentDay > currD)) { cTab[i].jun26 = null; cGir[i].jun26 = null; cDep[i].jun26 = null;}
      if (currM < 7 || (currM === 7 && currentDay > currD)) { cTab[i].jul26 = null; cGir[i].jul26 = null; cDep[i].jul26 = null;}
      if (currM < 8 || (currM === 8 && currentDay > currD)) { cTab[i].aug26 = null; cGir[i].aug26 = null; cDep[i].aug26 = null;}
      if (currM < 9 || (currM === 9 && currentDay > currD)) { cTab[i].sep26 = null; cGir[i].sep26 = null; cDep[i].sep26 = null;}
      if (currM < 10 || (currM === 10 && currentDay > currD)) { cTab[i].oct26 = null; cGir[i].oct26 = null; cDep[i].oct26 = null;}

      cDpk[i].jun26 = (cTab[i].jun26 !== null || cGir[i].jun26 !== null || cDep[i].jun26 !== null) ? (cTab[i].jun26 || 0) + (cGir[i].jun26 || 0) + (cDep[i].jun26 || 0) : null;
      cDpk[i].jul26 = (cTab[i].jul26 !== null || cGir[i].jul26 !== null || cDep[i].jul26 !== null) ? (cTab[i].jul26 || 0) + (cGir[i].jul26 || 0) + (cDep[i].jul26 || 0) : null;
      cDpk[i].aug26 = (cTab[i].aug26 !== null || cGir[i].aug26 !== null || cDep[i].aug26 !== null) ? (cTab[i].aug26 || 0) + (cGir[i].aug26 || 0) + (cDep[i].aug26 || 0) : null;
      cDpk[i].sep26 = (cTab[i].sep26 !== null || cGir[i].sep26 !== null || cDep[i].sep26 !== null) ? (cTab[i].sep26 || 0) + (cGir[i].sep26 || 0) + (cDep[i].sep26 || 0) : null;
      cDpk[i].oct26 = (cTab[i].oct26 !== null || cGir[i].oct26 !== null || cDep[i].oct26 !== null) ? (cTab[i].oct26 || 0) + (cGir[i].oct26 || 0) + (cDep[i].oct26 || 0) : null;
    }

    let currMonthKey: 'dec25'|'jun26'|'jul26'|'aug26'|'sep26'|'oct26'|null = null; let lastMonthKey: 'dec25'|'jun26'|'jul26'|'aug26'|'sep26'|'oct26'|null = null;
    if (currY === 2026) {
      if (currM === 6) { currMonthKey = 'jun26'; lastMonthKey = 'dec25'; } 
      else if (currM === 7) { currMonthKey = 'jul26'; lastMonthKey = 'jun26'; }
      else if (currM === 8) { currMonthKey = 'aug26'; lastMonthKey = 'jul26'; }
      else if (currM === 9) { currMonthKey = 'sep26'; lastMonthKey = 'aug26'; }
      else if (currM === 10) { currMonthKey = 'oct26'; lastMonthKey = 'sep26'; }
    } else if (currY === 2025 && currM === 12) currMonthKey = 'dec25';

    const dayIdx = currD > 0 ? currD - 1 : 0;
    const calculateStats = (arrFilled: ChartItem[], arrRaw: ChartItem[], hasDec25: boolean) => {
      if (!currMonthKey) return { val: null, dtd: null, mtd: null, mtm: null, ytd: null, snapshotDay: null };
      if (currMonthKey === 'dec25') return { val: arrFilled[0].dec25, dtd: null, mtd: null, mtm: null, ytd: null, snapshotDay: arrFilled[0].dec25 === null ? null : 31 };
      let effIdx = dayIdx; while (effIdx >= 0 && effIdx < 31 && arrRaw[effIdx][currMonthKey] === null) effIdx--; if (effIdx < 0) return { val: null, dtd: null, mtd: null, mtm: null, ytd: null, snapshotDay: null };
      let safeIdx = effIdx; if (safeIdx > 30) safeIdx = 30; if (safeIdx < 0) safeIdx = 0;
      const today = Number(arrFilled[safeIdx][currMonthKey]) || 0;
      const yesterdayValue = safeIdx > 0 ? arrRaw[safeIdx - 1][currMonthKey] : (lastMonthKey ? arrRaw[30][lastMonthKey] : null);
      const yesterday = yesterdayValue === null ? null : Number(yesterdayValue) || 0;
      const hasLastMonth = lastMonthKey === 'dec25' ? hasDec25 : Boolean(lastMonthKey && arrRaw.some(point => point[lastMonthKey] !== null));
      const lastMonth = lastMonthKey ? (Number(arrFilled[30][lastMonthKey]) || 0) : 0;
      const lastYear = Number(arrFilled[0].dec25) || 0;
      return { val: today, dtd: yesterday === null ? null : today - yesterday, mtd: hasLastMonth ? today - lastMonth : null, mtm: null, ytd: hasDec25 ? today - lastYear : null, snapshotDay: safeIdx + 1 };
    };

    const daysInSelectedMonth = new Date(currY, currM, 0).getDate();
    const dailyTotals = { dpk: new Map<number, number>(), tabungan: new Map<number, number>(), giro: new Map<number, number>(), deposito: new Map<number, number>() };
    (Object.values(ukerMap) as any[]).forEach(unit => {
      (Object.keys(dailyTotals) as ProductKey[]).forEach(product => {
        Object.entries(unit.monthlyPosByDay?.[product] || {}).forEach(([day, amount]) => {
          const dayNumber = Number(day);
          dailyTotals[product].set(dayNumber, (dailyTotals[product].get(dayNumber) || 0) + Number(amount));
        });
      });
    });
    const requiredCurrentDays = effectiveD || 0;
    const productLastDay = (product: ProductKey) => Math.max(0, ...[...dailyTotals[product].keys()].filter(day => day <= requiredCurrentDays));
    const aggregateDailyAverage = (product: ProductKey, requiredDays: number, sourceKey: 'posByDay' | 'monthlyPosByDay') => {
      if (!requiredDays) return null;
      const units = Object.values(ukerMap) as any[];
      const activeUnits = units.filter(unit => Object.keys(unit[sourceKey]?.[product] || {}).length > 0);
      if (!activeUnits.length) return null;
      const totals = new Map<number, number>();
      for (let day = 1; day <= requiredDays; day += 1) {
        let total = 0;
        for (const unit of activeUnits) {
          const unitDays = unit[sourceKey]?.[product] || {};
          if (!Object.prototype.hasOwnProperty.call(unitDays, day) || !Number.isFinite(unitDays[day])) return null;
          total += unitDays[day];
        }
        totals.set(day, total);
      }
      return calculateCompleteDailyAverage(totals, requiredDays);
    };
    const currentAverage = (product: ProductKey) => aggregateDailyAverage(product, productLastDay(product), 'posByDay');
    const historicalAverage = (product: ProductKey) => aggregateDailyAverage(product, daysInSelectedMonth, 'monthlyPosByDay');
    const snapshotMovement = (product: ProductKey) => {
      const lastDay = productLastDay(product);
      if (!lastDay) return { dtd: null, mtd: null, ytd: null };
      const currentDate = `${currY}-${String(currM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const previousDate = lastDay > 1
        ? `${currY}-${String(currM).padStart(2, '0')}-${String(lastDay - 1).padStart(2, '0')}`
        : (() => { const date = new Date(currY, currM - 1, 0); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; })();
      const monthEndDate = (() => { const date = new Date(currY, currM - 1, 0); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; })();
      const yearEndDate = '2025-12-31';
      const units = Object.values(ukerMap) as any[];
      const activeUnits = units.filter(unit => Object.keys(unit.monthlyPosByDay?.[product] || {}).length > 0);
      const totalAt = (dateKey: string) => {
        if (!activeUnits.length) return null;
        let total = 0;
        for (const unit of activeUnits) {
          const values = unit.dailySnapshots?.[dateKey];
          if (!values || !Object.prototype.hasOwnProperty.call(values, product) || !Number.isFinite(values[product])) return null;
          total += values[product];
        }
        return total;
      };
      const current = totalAt(currentDate);
      const previous = totalAt(previousDate);
      const monthEnd = totalAt(monthEndDate);
      const yearEnd = totalAt(yearEndDate);
      return {
        dtd: current !== null && previous !== null ? current - previous : null,
        mtd: current !== null && monthEnd !== null ? current - monthEnd : null,
        ytd: current !== null && yearEnd !== null ? current - yearEnd : null
      };
    };
    const monthlyDatesAvailable = (product: ProductKey) => dailyTotals[product].size;
    const currentDatesAvailable = (product: ProductKey) => [...dailyTotals[product].keys()].filter(day => day <= requiredCurrentDays).length;
    const statsTab = calculateStats(cTab, rawTab, dec25Snapshots.tabungan); const statsGir = calculateStats(cGir, rawGir, dec25Snapshots.giro); const statsDep = calculateStats(cDep, rawDep, dec25Snapshots.deposito); const statsDpk = calculateStats(cDpk, rawDpk, hasDec25Dpk);
    const summaryDay = effectiveD || currD;
    const summaryDayIdx = Math.min(Math.max(summaryDay - 1, 0), 30);
    const currentMonthLabel = `${namaBulanIndo[currM - 1] ?? ''} '${String(currY).slice(-2)}`;
    const previousDate = new Date(currY, currM - 2, 1);
    const previousMonthLabel = `${namaBulanIndo[previousDate.getMonth()]} '${String(previousDate.getFullYear()).slice(-2)}`;
    const previousMonthEndIndex = effectivePrevD ? effectivePrevD - 1 : -1;
    const summaryFor = (arr: ChartItem[], dec25Value: number | null, currentStats: { val: number | null }) => {
      const previousSameDay = lastMonthKey && lastMonthKey !== 'dec25' ? arr[summaryDayIdx][lastMonthKey] : null;
      const previousMonthEnd = lastMonthKey === 'dec25'
        ? dec25Value
        : previousMonthEndIndex >= 0 && lastMonthKey ? arr[previousMonthEndIndex][lastMonthKey] : null;
      const currentValue = currMonthKey ? arr[summaryDayIdx][currMonthKey] : currentStats.val;
      return [
        { name: "31 Des '25", value: dec25Value },
        { name: `${summaryDay.toString().padStart(2, '0')} ${previousMonthLabel}`, value: previousSameDay },
        { name: `${effectivePrevD ?? '—'} ${previousMonthLabel}`, value: previousMonthEnd },
        { name: `${effectiveD ?? '—'} ${currentMonthLabel}`, value: currentValue }
      ];
    };
    const summaryData = {
      tabungan: summaryFor(cTab, dec25Snapshots.tabungan ? dec25Tab : null, statsTab),
      giro: summaryFor(cGir, dec25Snapshots.giro ? dec25Gir : null, statsGir),
      deposito: summaryFor(cDep, dec25Snapshots.deposito ? dec25Dep : null, statsDep),
      dpk: summaryFor(cDpk, hasDec25Dpk ? dec25Tab + dec25Gir + dec25Dep : null, statsDpk)
    };

    const result = { 
      charts: { dpk: cDpk, tabungan: cTab, giro: cGir, deposito: cDep }, stats: { tabungan: statsTab, giro: statsGir, deposito: statsDep, dpk: statsDpk }, averages: { tabungan: currentAverage('tabungan'), giro: currentAverage('giro'), deposito: currentAverage('deposito'), dpk: currentAverage('dpk'), historical: { tabungan: historicalAverage('tabungan'), giro: historicalAverage('giro'), deposito: historicalAverage('deposito'), dpk: historicalAverage('dpk') }, movement: { dpk: snapshotMovement('dpk'), tabungan: snapshotMovement('tabungan'), giro: snapshotMovement('giro'), deposito: snapshotMovement('deposito') }, currD: effectiveD || 0, currentLastDay: { dpk: productLastDay('dpk'), tabungan: productLastDay('tabungan'), giro: productLastDay('giro'), deposito: productLastDay('deposito') }, daysInMonth: daysInSelectedMonth, snapshotDays: { dpk: currentSnapshotDays.dpk.size, tabungan: currentSnapshotDays.tabungan.size, giro: currentSnapshotDays.giro.size, deposito: currentSnapshotDays.deposito.size }, currentDatesAvailable: { dpk: currentDatesAvailable('dpk'), tabungan: currentDatesAvailable('tabungan'), giro: currentDatesAvailable('giro'), deposito: currentDatesAvailable('deposito') }, monthlyDatesAvailable: { dpk: monthlyDatesAvailable('dpk'), tabungan: monthlyDatesAvailable('tabungan'), giro: monthlyDatesAvailable('giro'), deposito: monthlyDatesAvailable('deposito') }, dailyTotals }, branchList: Object.values(branchMap), rawSummary: summaryData, effectiveD, effectivePrevD,
      ukerList: Object.values(ukerMap).map((u: any) => ({ ...u, ytd_diff: u.has_curr && u.has_des25 ? u.curr - u.des25 : null, mtd_diff: u.has_curr && u.has_prev ? u.curr - u.prev : null, dtd_diff: u.has_curr && u.has_d_min_1 ? u.curr - u.d_min_1 : null }))
    };
    engineDataCache.set(cacheKey, result);
    if (engineDataCache.size > 6) engineDataCache.delete(engineDataCache.keys().next().value!);
    return result;
  }, [dbSegmen, dataArea, dataCabang, dataUnit, selectedSegmen, selectedProduk, selectedPeriode, isDetailDataMode, isMarginalDataMode]);
  const modalChartData = useMemo(() => {
    if (!selectedUkerModal || dbSegmen.length === 0) return null;

    let currM = 10, currD = 7;
    if (selectedPeriode) {
      const parts = selectedPeriode.split(/[-/]/);
      if (parts.length >= 3) {
        let p0 = parseInt(parts[0], 10), p1 = parseInt(parts[1], 10), p2 = parseInt(parts[2].substring(0, 4), 10);
        if (p2 > 2000) { currM = p1; currD = p0; } else if (p0 > 2000) { currM = p1; currD = p2; }
      }
    }

    const initChart = (): ChartItem[] => Array.from({ length: 31 }, (_, i) => ({ day: i + 1, dec25: null, jun26: null, jul26: null, aug26: null, sep26: null, oct26: null }));
    const cTab = initChart();
    let dec25Tab = 0;
    let hasDec25Tab = false;

    dbSegmen.forEach((row) => {
      if (row.isUkerKonsolidasi) return;

      const cleanUker = row.ukerOri.trim();
      const cleanCabang = row.cabang.replace(/\(KONSOLIDASI.*/g, '').replace(/-MDI.*/g, '').trim();

      if (cleanUker === selectedUkerModal.uker && cleanCabang === selectedUkerModal.cabang) {
        if (row.segmen.includes('MIKRO') && row.isTab) {
          if (row.y === 2025 && row.m === 12 && row.d === 31) {
            hasDec25Tab = true;
            dec25Tab += row.saldo; 
          } else if (row.y === 2026 && row.d >= 1 && row.d <= 31) {
            const idx = row.d - 1;
            if (row.m === 6) cTab[idx].jun26 = (cTab[idx].jun26 || 0) + row.saldo;
            else if (row.m === 7) cTab[idx].jul26 = (cTab[idx].jul26 || 0) + row.saldo;
            else if (row.m === 8) cTab[idx].aug26 = (cTab[idx].aug26 || 0) + row.saldo;
            else if (row.m === 9) cTab[idx].sep26 = (cTab[idx].sep26 || 0) + row.saldo;
            else if (row.m === 10) cTab[idx].oct26 = (cTab[idx].oct26 || 0) + row.saldo;
          }
        }
      }
    });

    for (let i = 0; i < 31; i++) {
      cTab[i].dec25 = hasDec25Tab ? dec25Tab : null; 
      if (i > 0) {
        if (cTab[i].jun26 === null) cTab[i].jun26 = cTab[i-1].jun26; 
        if (cTab[i].jul26 === null) cTab[i].jul26 = cTab[i-1].jul26; 
        if (cTab[i].aug26 === null) cTab[i].aug26 = cTab[i-1].aug26; 
        if (cTab[i].sep26 === null) cTab[i].sep26 = cTab[i-1].sep26; 
        if (cTab[i].oct26 === null) cTab[i].oct26 = cTab[i-1].oct26;
      }
      const currentDay = i + 1;
      if (currM < 6 || (currM === 6 && currentDay > currD)) cTab[i].jun26 = null; 
      if (currM < 7 || (currM === 7 && currentDay > currD)) cTab[i].jul26 = null; 
      if (currM < 8 || (currM === 8 && currentDay > currD)) cTab[i].aug26 = null; 
      if (currM < 9 || (currM === 9 && currentDay > currD)) cTab[i].sep26 = null; 
      if (currM < 10 || (currM === 10 && currentDay > currD)) cTab[i].oct26 = null; 
    }
    return cTab;
  }, [selectedUkerModal, dbSegmen, selectedPeriode]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(false); }
  };

  const processedTableData = useMemo(() => {
    let data = [...engineData.ukerList];
    if (searchUker) { 
      const s = searchUker.toUpperCase();
      data = data.filter(d => d.uker.toUpperCase().includes(s) || d.cabang.toUpperCase().includes(s)); 
    }
    data.sort((a, b) => {
      if (sortField === 'uker') return sortAsc ? a.uker.localeCompare(b.uker) : b.uker.localeCompare(a.uker);
      if (sortField === 'achievement') return 0;
      const valA = Number(a[sortField]) || 0;
      const valB = Number(b[sortField]) || 0;
      return sortAsc ? valA - valB : valB - valA;
    });
    return data;
  }, [engineData.ukerList, searchUker, sortField, sortAsc]);

  const displayedTableData = processedTableData;

  const monthColsIdx = selectedPeriode ? parseInt(selectedPeriode.split('-')[1], 10) - 1 : 9;
  let teksTanggal = "—";
  let teksBulanSaja = "—";
  let teksBulanSebelumnya = "—";
  let teksD1 = "—"; 
  
  if (selectedPeriode) {
    const parts = selectedPeriode.split('-');
    if (parts.length === 3) {
      const pTahunFull = parseInt(parts[0], 10);
      const pTahun = parts[0].substring(2, 4);
      const pBulan = parseInt(parts[1], 10);
      const currentDay = engineData.effectiveD;
      
      teksTanggal = currentDay ? `${currentDay.toString().padStart(2, '0')} ${namaBulanIndo[pBulan - 1]} ${pTahun}` : '—';
      teksBulanSaja = `${namaBulanIndo[pBulan - 1]} ${pTahun}`;
      
      const previousMonthDate = new Date(pTahunFull, pBulan - 2, 1);
      const prevMonth = previousMonthDate.getMonth() + 1;
      const prevYear = previousMonthDate.getFullYear();
      const previousSnapshotDay = engineData.effectivePrevD;
      teksBulanSebelumnya = previousSnapshotDay ? `${previousSnapshotDay.toString().padStart(2, '0')} ${namaBulanIndo[prevMonth - 1]} '${String(prevYear).slice(-2)}` : '—';
      if (currentDay && currentDay > 1) teksD1 = `${(currentDay - 1).toString().padStart(2, '0')} ${namaBulanIndo[pBulan - 1]}`;
      else if (previousSnapshotDay) teksD1 = `${previousSnapshotDay.toString().padStart(2, '0')} ${namaBulanIndo[prevMonth - 1]}`;
    }
  }

  const getRkaTargetResult = (code: string | number | null, targetCategory: string, monthIndex = monthColsIdx) => {
    const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    if (!dbRka.length) return { value: null, reason: 'Data sumber RKA belum dimuat.' };
    if (code === null || String(code).trim() === '') return { value: null, reason: 'Kode unit belum terpetakan ke master unit kerja.' };
    const selectedYear = selectedPeriode.split('-')[0];
    if (selectedYear && selectedYear !== '2026') return { value: null, reason: `Target RKA tersedia untuk 2026, bukan periode ${selectedYear}.` };
    if (!Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) return { value: null, reason: 'Periode posisi tidak dikenali.' };

    const normalizedCode = String(code).trim();
    const normalizedCategory = (targetCategory.trim().toUpperCase().startsWith('A ')
      ? targetCategory.trim() : `A ${targetCategory.trim()}`).toUpperCase();
    const matches = rkaRowsByCodeCategory.get(`${normalizedCode}\u0000${normalizedCategory}`) || [];
    if (matches.length === 0) return { value: null, reason: `Tidak ada baris “${targetCategory}” untuk kode ${normalizedCode}.` };
    if (matches.length > 1) return { value: null, reason: `Baris “${targetCategory}” untuk kode ${normalizedCode} tidak unik.` };

    const value = getRkaValFromRow(matches[0], monthIndex);
    if (value === null) return { value: null, reason: `Nilai target ${monthNames[monthIndex]} kosong atau tidak terbaca pada sumber RKA.` };
    return { value, reason: null };
  };

  const detailRkaByUnit = useMemo(() => new Map(displayedTableData.map(unit => {
    const kode = findKodeUker(unit.uker, unit.kode_uker);
    const monthly = getRkaTargetResult(kode, 'A Tabungan Retail Funding');
    const december = getRkaTargetResult(kode, 'A Tabungan Retail Funding', 11);
    const master = kode ? ukerByCode.get(kode) : null;
    const unitType = String(master?.['BRANCH TYPE'] ?? '').trim().toUpperCase();
    const mainBranchCode = String(master?.['MAIN BRANCH CODE'] ?? '').trim();
    const kcCode = unitType === 'KC' ? kode : mainBranchCode;
    return [unit, {
      kode,
      unitType: ['KC', 'KCP', 'UNIT'].includes(unitType) ? unitType : '—',
      kcCode: kcCode || null,
      kcName: kcCode ? (branchNameByCode.get(kcCode) || null) : null,
      monthly: monthly.value,
      monthlyStatus: monthly.reason,
      december: december.value,
      decemberStatus: december.reason
    }];
  })), [displayedTableData, branchCodeByName, branchNameByCode, ukerByCode, rkaRowsByCodeCategory, selectedPeriode, monthColsIdx]);
  const groupedDetailData = useMemo(() => {
    const groups = new Map<string, { name: string; kcCode: string | null; units: any[] }>();
    displayedTableData.forEach(unit => {
      const metadata = detailRkaByUnit.get(unit);
      const key = metadata?.kcCode ? `KC:${metadata.kcCode}` : `NAME:${unit.cabang}`;
      const name = metadata?.kcName || unit.cabang;
      if (!groups.has(key)) groups.set(key, { name, kcCode: metadata?.kcCode || null, units: [] });
      groups.get(key)!.units.push(unit);
    });
    return [...groups.entries()].map(([key, group]) => ({ key, ...group })).sort((a, b) => a.name.localeCompare(b.name, 'id'));
  }, [displayedTableData, detailRkaByUnit]);
  const sortedDetailUnits = (units: any[]) => [...units].sort((a, b) => {
        const metadataA = detailRkaByUnit.get(a);
        const metadataB = detailRkaByUnit.get(b);
        const hierarchyRank = (type?: string) => type === 'KC' ? 0 : type === 'KCP' ? 1 : 2;
        const typeOrder = hierarchyRank(metadataA?.unitType ?? a.unitType) - hierarchyRank(metadataB?.unitType ?? b.unitType);
        if (typeOrder !== 0) return typeOrder;
        if (sortField !== 'achievement') return 0;
        const targetA = detailRkaByUnit.get(a)?.monthly;
        const targetB = detailRkaByUnit.get(b)?.monthly;
        const pctA = targetA !== null && targetA !== undefined && targetA > 0 && a.has_curr ? a.curr / targetA * 100 : null;
        const pctB = targetB !== null && targetB !== undefined && targetB > 0 && b.has_curr ? b.curr / targetB * 100 : null;
        if (pctA === null && pctB !== null) return 1;
        if (pctA !== null && pctB === null) return -1;
        if (pctA === null || pctB === null) return a.uker.localeCompare(b.uker, 'id');
        return (sortAsc ? pctA - pctB : pctB - pctA) || a.uker.localeCompare(b.uker, 'id');
      });
  const detailGroupTotals = (units: any[]) => {
    const totals = { rka: 0, rkaDec: 0, des25: 0, prev: 0, d1: 0, curr: 0 };
    const complete = { rka: true, rkaDec: true, des25: true, prev: true, d1: true, curr: true };
    units.forEach(unit => {
      const rka = detailRkaByUnit.get(unit);
      if (rka?.monthly === null || rka?.monthly === undefined) complete.rka = false; else totals.rka += rka.monthly;
      if (rka?.december === null || rka?.december === undefined) complete.rkaDec = false; else totals.rkaDec += rka.december;
      if (unit.has_des25) totals.des25 += unit.des25; else complete.des25 = false;
      if (unit.has_prev) totals.prev += unit.prev; else complete.prev = false;
      if (unit.has_d_min_1) totals.d1 += unit.d_min_1; else complete.d1 = false;
      if (unit.has_curr) totals.curr += unit.curr; else complete.curr = false;
    });
    return { totals, complete };
  };
  const detailChildrenForGroup = (group: { name: string; kcCode: string | null; units: any[] }) => {
    const children = group.units.filter(unit => detailRkaByUnit.get(unit)?.unitType !== 'KC');
    const existingKcpCodes = new Set(children.map(unit => detailRkaByUnit.get(unit)?.kode).filter(Boolean));
    const kcpPlaceholders = group.kcCode && (selectedUnit === 'ALL' || selectedUnit === 'KCP')
      ? dbUkerList.filter(master => String(master?.['MAIN BRANCH CODE'] ?? '').trim() === group.kcCode
          && String(master?.['BRANCH TYPE'] ?? '').trim().toUpperCase() === 'KCP'
          && (!searchUker || String(master?.BRANCH ?? '').toUpperCase().includes(searchUker.toUpperCase()))
          && !existingKcpCodes.has(String(master?.['BRANCH CODE'] ?? '').trim()))
        .map(master => ({
          uker: String(master?.BRANCH ?? '').trim(), cabang: group.name,
          kode_uker: String(master?.['BRANCH CODE'] ?? '').trim(), unitType: 'KCP', synthetic: true,
          has_curr: false, has_prev: false, has_des25: false, has_d_min_1: false,
          curr: null, prev: null, des25: null, d_min_1: null,
          ytd_diff: null, mtd_diff: null, dtd_diff: null
        }))
      : [];
    return sortedDetailUnits([...children, ...kcpPlaceholders]);
  };
  const unitsWithoutCode = useMemo(() => [...detailRkaByUnit.values()].filter(rka => !rka.kode).length, [detailRkaByUnit]);
  const unitsWithoutTarget = useMemo(() => [...detailRkaByUnit.values()].filter(rka => rka.monthly === null || rka.december === null).length, [detailRkaByUnit]);

  const calculateRkaAggregate = (targetCategory: string) => {
    const units = engineData.ukerList;
    if (!units.length) return { value: null, position: null, complete: false, available: 0, total: 0, targetAvailable: 0, unmapped: 0, missingTarget: 0, missingPosition: 0, reason: 'Tidak ada unit pada cakupan filter untuk dibandingkan.', diagnostics: [] as string[] };
    const category = targetCategory.toUpperCase();
    const product = category.includes('TABUNGAN') ? 'tabungan'
      : category.includes('DEPOSITO') ? 'deposito'
      : category.includes('GIRO') ? 'giro' : 'dpk';
    const isAverageTarget = category.includes('AVERAGE DAILY');
    const averageRequiredDays = engineData.averages.daysInMonth;
    const positionSnapshotDay = engineData.stats[product].snapshotDay;
    let targetSubtotal = 0;
    let allValidTargetSubtotal = 0;
    let positionSubtotal = 0;
    let compared = 0;
    let targetAvailable = 0;
    let unmapped = 0;
    let missingTarget = 0;
    let missingPosition = 0;
    let duplicate = 0;
    const diagnostics: string[] = [];
    const addDiagnostic = (message: string) => { if (diagnostics.length < 4) diagnostics.push(message); };
    const seenCodes = new Set<string>();
    for (const unit of units) {
      const code = findKodeUker(unit.uker, unit.kode_uker);
      if (!code) {
        unmapped += 1;
        addDiagnostic(`${unit.uker}: kode tidak ditemukan atau ambigu di master BRANCH.`);
        continue;
      }
      if (seenCodes.has(code)) {
        duplicate += 1;
        addDiagnostic(`${unit.uker}: kode ${code} terduplikasi pada cakupan filter.`);
        continue;
      }
      seenCodes.add(code);
      const target = getRkaTargetResult(code, targetCategory);
      if (target.value === null) {
        missingTarget += 1;
        addDiagnostic(`${unit.uker} (${code}): ${target.reason}`);
        continue;
      }
      targetAvailable += 1;
      allValidTargetSubtotal += target.value;

      const positionDays: Record<number, number> = unit.posByDay?.[product] || {};
      const averageDailyPositions: Record<number, number> = unit.monthlyPosByDay?.[product] || {};
      const calculatedUnitAverage = isAverageTarget
        ? calculateCompleteDailyAverage(new Map(Object.entries(averageDailyPositions).map(([day, value]) => [Number(day), Number(value)])), averageRequiredDays || 0)
        : null;
      const hasPosition = isAverageTarget
        ? calculatedUnitAverage !== null
        : positionSnapshotDay !== null && positionSnapshotDay !== undefined && Object.prototype.hasOwnProperty.call(positionDays, positionSnapshotDay);
      if (!hasPosition) {
        missingPosition += 1;
        addDiagnostic(`${unit.uker} (${code}): posisi ${isAverageTarget ? 'Average Daily' : 'periode terpilih'} untuk kategori ${product} tidak tersedia.`);
        continue;
      }

      const positionValue = isAverageTarget
        ? calculatedUnitAverage
        : positionSnapshotDay === null || positionSnapshotDay === undefined ? null : positionDays[positionSnapshotDay];
      if (typeof positionValue !== 'number' || !Number.isFinite(positionValue)) {
        missingPosition += 1;
        addDiagnostic(`${unit.uker} (${code}): nilai posisi kategori ${product} bukan angka valid.`);
        continue;
      }
      targetSubtotal += target.value;
      positionSubtotal += positionValue;
      compared += 1;
    }
    const complete = compared === units.length;
    const reason = complete ? null
      : isAverageTarget && targetAvailable > 0
        ? `Target tersedia untuk ${targetAvailable}/${units.length} unit; posisi aktual belum lengkap untuk perhitungan bulan penuh (${missingPosition} posisi tidak tersedia, ${unmapped} kode belum terpetakan, ${missingTarget} target tidak tersedia, ${duplicate} kode duplikat).`
        : `Target parsial: ${compared}/${units.length} unit dapat dibandingkan (${unmapped} belum terpetakan, ${missingTarget} target kategori/periode tidak tersedia, ${missingPosition} posisi tidak tersedia, ${duplicate} kode duplikat).`;
    return {
      value: isAverageTarget
        ? targetAvailable ? allValidTargetSubtotal : null
        : compared ? targetSubtotal : null,
      position: compared ? positionSubtotal : null,
      complete,
      available: compared,
      total: units.length,
      targetAvailable,
      unmapped,
      missingTarget,
      missingPosition,
      reason,
      diagnostics
    };
  };

  const rkaAggregateResults = useMemo(() => {
    const categories = [
      'Tabungan Retail Funding', 'Deposito Retail Funding', 'Giro Retail Funding', 'DPK Retail Funding Total',
      'Tabungan Korporasi', 'Deposito Korporasi', 'Giro Korporasi',
      'Average daily Tabungan Retail Funding', 'Average daily Deposito Retail Funding', 'Average daily Giro Retail Funding', 'Average daily Simpanan Retail Funding Total',
      'Average daily Tabungan Korporasi', 'Average daily Deposito Korporasi', 'Average daily Giro Korporasi'
    ];
    return new Map(categories.map(category => [category, calculateRkaAggregate(category)]));
  }, [engineData.ukerList, engineData.effectiveD, engineData.averages.daysInMonth, branchCodeByName, rkaRowsByCodeCategory, selectedPeriode, monthColsIdx]);

  const getRkaAggregate = (targetCategory: string) => rkaAggregateResults.get(targetCategory)
    || { value: null, position: null, complete: false, available: 0, total: engineData.ukerList.length, reason: `Kategori target “${targetCategory}” tidak terdaftar untuk agregasi.`, diagnostics: [] as string[] };

  const rkaTargetSuffix = selectedSegmen === 'Non-Wholesale (Ritel & Mikro)' ? 'Retail Funding'
    : selectedSegmen === 'Wholesale' ? 'Korporasi' : null;
  const unavailableRkaResult = (reason: string) => ({
    value: null, position: null, complete: false, available: 0, total: engineData.ukerList.length,
    targetAvailable: 0, unmapped: 0, missingTarget: engineData.ukerList.length,
    missingPosition: 0, reason, diagnostics: [] as string[]
  });

  const averageRows = useMemo(() => {
    const suffix = rkaTargetSuffix || selectedSegmen;
    const category = averageTableProduct === 'dpk' ? `Average daily Simpanan ${suffix} Total`
      : `Average daily ${averageTableProduct === 'tabungan' ? 'Tabungan' : averageTableProduct === 'deposito' ? 'Deposito' : 'Giro'} ${suffix}`;
    const requiredDays = engineData.averages.daysInMonth;
    return engineData.ukerList.map((unit: any) => {
      const code = findKodeUker(unit.uker, unit.kode_uker);
      const target = !rkaTargetSuffix
        ? { value: null, reason: `Target Average Daily ${selectedSegmen} tidak tersedia sebagai kategori terpisah pada RKA.` }
        : selectedSegmen === 'Wholesale' && averageTableProduct === 'dpk'
          ? { value: null, reason: 'Target Average Daily DPK Korporasi tidak tersedia pada sumber.' }
          : getRkaTargetResult(code, category);
      const daily: Record<number, number> = unit.monthlyPosByDay?.[averageTableProduct] || {};
      const actual = calculateCompleteDailyAverage(
        new Map(Object.entries(daily).map(([day, amount]) => [Number(day), Number(amount)])),
        requiredDays
      );
      const targetValue = target.value;
      const percentage = actual !== null && targetValue !== null && targetValue > 0 ? actual / targetValue * 100 : null;
      return {
        unit, name: unit.uker as string, branch: unit.cabang as string, code, actual, target: targetValue,
        percentage, gap: actual !== null && targetValue !== null ? actual - targetValue : null, daily,
        status: !code ? 'Kode unit belum terpetakan.'
          : actual === null ? `Saldo harian belum lengkap untuk ${requiredDays} hari.`
          : targetValue === null ? target.reason || 'Target Average Daily tidak ditemukan.'
          : targetValue === 0 ? 'Target bernilai 0; persentase tidak dapat dihitung.'
          : 'Terverifikasi untuk cakupan tersedia.'
      };
    }).sort((a: any, b: any) => averageSortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name));
  }, [engineData.ukerList, engineData.effectiveD, engineData.averages.daysInMonth, averageTableProduct, averageSortAsc, selectedSegmen, rkaTargetSuffix, branchCodeByName, rkaRowsByCodeCategory, selectedPeriode, monthColsIdx]);

  const averageTrend = useMemo(() => {
    const comparable = averageRows.filter((row: any) => row.target !== null && row.actual !== null);
    const targetRows = averageRows.filter((row: any) => row.target !== null);
    const dayCount = engineData.averages.daysInMonth;
    const target = targetRows.reduce((sum: number, row: any) => sum + row.target, 0);
    return Array.from({ length: dayCount }, (_, index) => {
      const day = index + 1;
      const actual = comparable.length > 0 && comparable.every((row: any) => Number.isFinite(row.daily[day]))
        ? comparable.reduce((sum: number, row: any) => sum + row.daily[day], 0)
        : null;
      return { day, actual, target: targetRows.length ? target : null };
    });
  }, [averageRows, engineData.averages.daysInMonth]);

  const handleLegendClick = (e: any) => {
    if (e && e.dataKey) {
      setVisibleLines(prev => ({ ...prev, [e.dataKey]: !prev[e.dataKey] }));
    }
  };

  const handleResetLegend = () => {
    setVisibleLines({ dec25: true, jun26: true, jul26: true, aug26: true, sep26: true, oct26: true });
  };

  if (authStage === 'init' || authStage === 'fetching_data') {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-slate-200 px-4 font-sans">
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-300 flex flex-col items-center max-w-sm w-full text-center relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-1 bg-[#004a8c]"></div>
          <Loader2 className="animate-spin text-[#004a8c] mb-4" size={32} strokeWidth={2.5}/>
          <h2 className="text-sm text-slate-800 font-bold tracking-tight">
            {authStage === 'init' ? 'Menyiapkan sistem...' : 'Sedang memuat data...'}
          </h2>
          <p className="text-[10px] text-slate-500 mt-1 font-medium">Regional Office Malang</p>
        </div>
      </div>
    );
  }

  if (authStage === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 p-4 font-sans">
        <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-6 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-rose-600"><Info size={20}/></div>
          <h2 className="text-base font-bold text-slate-800">Data gagal dimuat</h2>
          <p className="mt-2 text-sm text-slate-600">{loadError || 'Terjadi kendala saat membaca sumber data.'}</p>
          <button type="button" onClick={() => { setLoadError(''); setAuthStage(loggedInUser ? 'fetching_data' : 'init'); }} className="mt-5 rounded-lg bg-[#004a8c] px-4 py-2 text-sm font-bold text-white hover:bg-[#00386b]">Coba lagi</button>
        </div>
      </div>
    );
  }

  if (authStage === 'login') {
    return (
      <div className="min-h-screen bg-slate-100 flex flex-col justify-center items-center p-4 text-sm font-sans relative overflow-hidden">
        <div className="bg-white shadow-xl w-full max-w-[360px] rounded-2xl overflow-hidden border border-slate-300 z-10">
          <div className="bg-[#0f172a] p-8 flex flex-col items-center text-center relative">
            <div className="w-12 h-12 rounded-xl bg-[#004a8c] mb-4 flex items-center justify-center shadow-sm relative z-10">
              <Landmark size={24} className="text-white" strokeWidth={2} />
            </div>
            <h1 className="text-white text-lg tracking-[0.14em] font-black relative z-10">DASHBOARD FUNDING</h1>
            <p className="text-indigo-200 text-[9px] mt-1.5 font-medium tracking-widest uppercase relative z-10">Monitoring & Kinerja</p>
          </div>
          <div className="p-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-[9px] text-slate-500 uppercase tracking-widest mb-1.5 font-bold ml-1">Nomor Personel (PN)</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                  <input type="text" value={inputPN} onChange={(e) => setInputPN(e.target.value)} placeholder="Ketik PN Anda..." className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-300 rounded-lg text-slate-800 outline-none focus:bg-white focus:border-[#004a8c] transition-all font-medium text-xs" />
                </div>
              </div>
              {loginError && (
                <div className="bg-rose-50 text-rose-600 text-[10px] p-2.5 rounded-lg border border-rose-200 flex items-center gap-1.5 font-medium">
                  <X size={12} className="shrink-0" /> {loginError}
                </div>
              )}
              <button type="submit" className="w-full bg-[#004a8c] hover:bg-[#00386b] active:scale-[0.98] text-white py-2.5 rounded-lg text-xs transition-all flex items-center justify-center gap-2 font-bold shadow-sm cursor-pointer">
                <Lock size={14} /> MASUK
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white/95 backdrop-blur-sm p-3 shadow-lg rounded-xl border border-slate-200 text-[10px] z-50 min-w-[160px]">
          <p className="text-slate-500 mb-2 border-b border-slate-200 pb-1.5 font-semibold flex items-center justify-between">
            <span>Tanggal {label}</span>
          </p>
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center justify-between gap-4 mb-1.5 last:mb-0">
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: entry.color }}></div>
                <span className="text-slate-600 font-medium">{entry.name}</span>
              </div>
          <span className="text-slate-800 font-bold" title={typeof entry.value === 'number' ? `Rp ${formatExactAmount(entry.value)}` : undefined}>{entry.value === null || entry.value === undefined ? '—' : `Rp ${formatUangDetail(entry.value)}`}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };
  
  const CustomSummaryTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white/95 backdrop-blur-sm p-3 shadow-lg rounded-xl border border-slate-200 text-[10px] z-50 min-w-[150px]">
          <p className="text-slate-500 mb-1.5 border-b border-slate-200 pb-1 font-bold text-center">
            {label}
          </p>
          {payload.map((entry: any, index: number) => (
            <div key={index} className="flex items-center justify-between gap-4">
              <span className="text-slate-600 font-medium">Saldo:</span>
              <span className="text-slate-800 font-bold" title={typeof entry.value === 'number' ? `Rp ${formatExactAmount(entry.value)}` : undefined}>{entry.value === null || entry.value === undefined ? '—' : `Rp ${formatUangDetail(entry.value)}`}</span>
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  const renderFilterBar = () => (
    <div className="min-w-0 bg-white p-3 sm:p-4 rounded-xl shadow-sm border border-slate-300 mb-4">
      <div className="flex flex-col xl:flex-row justify-between gap-3 items-stretch xl:items-end">
        <div className="grid min-w-0 w-full grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-slate-500 font-bold ml-0.5 flex items-center gap-1"><Filter size={10}/>Area Kerja</label>
            <select value={selectedArea} onChange={(e) => { setSelectedArea(e.target.value); setSelectedCabang('ALL'); setSelectedUnit('ALL'); }} className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-[11px] text-slate-700 font-medium outline-none cursor-pointer focus:border-[#004a8c] transition-all">
              <option value="ALL">Semua Area (Kanwil)</option>
              {Object.keys(REGION_MALANG_MAPPING).map((area) => <option key={area} value={area}>{area}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-slate-500 font-bold ml-0.5">Kantor Cabang</label>
            <select value={selectedCabang} onChange={(e) => { setSelectedCabang(e.target.value); setSelectedUnit('ALL'); }} className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-[11px] text-slate-700 font-medium outline-none cursor-pointer focus:border-[#004a8c] transition-all">
              <option value="ALL">Semua Cabang ({availableCabang.length})</option>
              {availableCabang.map((cab) => <option key={cab} value={cab}>{cab}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-slate-500 font-bold ml-0.5">Tipe Unit</label>
            <select value={selectedUnit} onChange={(e) => setSelectedUnit(e.target.value)} className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-[11px] text-slate-700 font-medium outline-none cursor-pointer focus:border-[#004a8c] transition-all">
              <option value="ALL">Semua Tipe Unit</option>
              <option value="KC">KC (Kantor Cabang)</option>
              <option value="KCP">KCP (Cabang Pembantu)</option>
              <option value="KK">KK (Kantor Kas)</option>
              <option value="UNIT">UNIT (BRI Unit)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[9px] text-slate-500 font-bold ml-0.5">Periode Posisi</label>
            <input type="date" value={selectedPeriode} max={latestPeriode} onChange={(e) => setSelectedPeriode(e.target.value)} className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-[11px] text-slate-700 font-medium outline-none cursor-pointer focus:border-[#004a8c] transition-all" />
          </div>
        </div>
        <button onClick={handleResetFilters} className="w-full xl:w-auto min-h-10 justify-center shrink-0 px-3 py-2 rounded-lg border border-slate-300 bg-white text-[10px] font-bold text-slate-600 hover:bg-slate-50 flex items-center gap-1.5">
          <RotateCcw size={12}/> Reset filter
        </button>
      </div>
    </div>
  );

  const StatCardV2 = ({ title, icon: Icon, themeCode, textCode, dataVal, comparisonPosition, rkaVal, rkaStatus, rkaComplete = true, rkaComparedUnits = 0, rkaTargetUnits = 0, rkaTotalUnits = 0, averagePositionCoverage, averageTargetCoverage, averagePositionStatus, progVal, progStatus, progIsTarget = false, showPrognosis = false, isAverageMode, dtd, mtd, mtm, ytd, onClick }: any) => {
    const hasData = typeof dataVal === 'number' && Number.isFinite(dataVal);
    const hasRkaValue = typeof rkaVal === 'number' && Number.isFinite(rkaVal);
    const hasComparisonPosition = typeof comparisonPosition === 'number' && Number.isFinite(comparisonPosition);
    const hasRka = hasRkaValue && hasComparisonPosition;
    const hasProg = typeof progVal === 'number' && Number.isFinite(progVal);
    const pctCapaian = hasRka && rkaVal > 0 ? (comparisonPosition / rkaVal) * 100 : null;
    const achievementTone = getAchievementTone(pctCapaian);
    const gapRka = hasRka ? comparisonPosition - rkaVal : null;

    const pctPrognosa = progIsTarget ? calculatePrognosisAchievement(dataVal, progVal) : null;
    const prognosisTone = getAchievementTone(pctPrognosa);
    const targetStatus = !rkaComplete && hasRka
      ? (rkaStatus || 'Cakupan target pembanding belum lengkap.')
      : !hasRka ? (rkaStatus || 'Target RKA atau posisi pembanding belum dapat diverifikasi.')
      : rkaVal === 0 ? 'Target RKA bernilai 0 sehingga persentase tidak dapat dihitung.'
      : '';
    const positionStatus = averagePositionStatus || (!hasData ? 'Total posisi aktual untuk periode ini belum tersedia.' : '');
    const formatBawah = (label: string, val: number | null | undefined) => {
      const hasValue = typeof val === 'number' && Number.isFinite(val);
      const isPositive = hasValue && val > 0;
      const isNegative = hasValue && val < 0;
      const unavailableReason = isAverageMode ? label === 'DTD' ? 'Snapshot tanggal sebelumnya tidak tersedia lengkap untuk unit dan kategori terpilih.'
        : label === 'MTD' ? 'Snapshot akhir bulan sebelumnya tidak tersedia lengkap untuk unit dan kategori terpilih.'
        : 'Snapshot 31 Desember 2025 tidak tersedia lengkap untuk unit dan kategori terpilih.'
        : !hasData ? 'Posisi aktual untuk periode ini belum tersedia.'
        : label === 'DTD' ? 'Snapshot hari sebelumnya tidak tersedia.'
        : label === 'MTD' ? 'Snapshot akhir bulan sebelumnya tidak tersedia.'
        : label === 'YTD' ? 'Snapshot akhir Desember 2025 tidak tersedia.'
        : 'Nilai MTM belum dihitung oleh model saat ini.';
      return (
        <div className="flex flex-col items-center justify-center py-1.5 px-0.5" title={!hasValue ? unavailableReason : undefined} aria-label={!hasValue ? `${label}: ${unavailableReason}` : undefined}>
          <span className="text-[9px] text-slate-500 font-semibold mb-0.5" title={isAverageMode ? `Perubahan posisi snapshot ${label}` : undefined}>{label}</span>
          <span className={`text-[11px] font-bold inline-flex items-center justify-center gap-0.5 ${isPositive ? 'text-emerald-600' : isNegative ? 'text-rose-600' : 'text-slate-500'}`}>
            {!hasValue ? '—' : formatUangDelta(val)}
            {isPositive && <ArrowUpRight size={12} strokeWidth={3.25}/>}
            {isNegative && <ArrowDownRight size={12} strokeWidth={3.25}/>}
          </span>
        </div>
      )
    };

    return (
      <div onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={onClick ? (event: React.KeyboardEvent<HTMLDivElement>) => { if (event.key === 'Enter' || event.key === ' ') onClick(); } : undefined} className={`h-full min-h-[300px] min-w-0 w-full bg-white rounded-2xl shadow-[0_4px_18px_rgba(15,23,42,0.06)] overflow-hidden flex flex-col border border-slate-200 relative text-center font-sans ${onClick ? 'cursor-pointer hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-200' : ''}`}>
        <div className="absolute top-0 inset-x-0 h-1" style={{ backgroundColor: themeCode }}></div>

        <div className="px-4 pt-3 pb-2.5 flex items-center justify-center gap-2 min-h-[48px]">
          <div className="p-1.5 rounded-lg shrink-0" style={{ backgroundColor: themeCode + '12', color: themeCode }}>
            <Icon size={17} strokeWidth={2.4} />
          </div>
          <span className="text-xs sm:text-sm font-extrabold tracking-wide text-slate-800 leading-tight">{title}</span>
        </div>

        <div className="grid grid-cols-2 divide-x divide-slate-200 border-y border-slate-100">
          <div className="min-w-0 flex flex-col items-center justify-center px-2 py-2.5">
            <span className="text-[9px] text-slate-500 font-semibold mb-1">{isAverageMode ? 'Posisi Pembanding' : 'Posisi Dana'} · {teksTanggal}</span>
            <span className="text-base sm:text-lg font-extrabold tracking-tight leading-tight break-words" style={{ color: textCode }} title={hasData ? `Rp ${formatExactAmount(dataVal)}` : positionStatus}>{formatUangMaybe(dataVal)}</span>
            {isAverageMode && <span className="text-[8px] text-slate-400 mt-0.5">{averagePositionCoverage || `${rkaComparedUnits}/${rkaTotalUnits} unit pembanding`}</span>}
            {isAverageMode && averagePositionStatus && <span className="text-[8px] text-slate-500 mt-1 leading-tight" title={averagePositionStatus}>{averagePositionStatus}</span>}
          </div>
          <div className="min-w-0 flex flex-col items-center justify-center px-2 py-2.5">
            <span className="text-[9px] text-slate-500 font-semibold mb-1" title={targetStatus || undefined}>Target RKA · {teksBulanSaja}</span>
            <span className="text-base sm:text-lg font-extrabold text-slate-700 tracking-tight leading-tight break-words" title={hasRkaValue ? `Rp ${formatExactAmount(rkaVal)}${!rkaComplete ? ` · ${targetStatus}` : ''}` : targetStatus || undefined}>{hasRkaValue ? formatUangDetail(rkaVal) : '—'}</span>
            {isAverageMode && <span className="text-[8px] text-slate-400 mt-0.5">{averageTargetCoverage || `${rkaTargetUnits}/${rkaTotalUnits} unit target valid`}</span>}
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-slate-200 border-b border-slate-100 bg-slate-50/60">
          <div className="min-w-0 flex flex-col items-center justify-center px-2 py-2">
            <span className="text-[9px] text-slate-500 font-semibold mb-0.5">Pencapaian RKA</span>
            <span title={pctCapaian === null ? targetStatus || 'Target atau posisi pembanding belum tersedia.' : !rkaComplete ? targetStatus || undefined : undefined} className={`text-base font-extrabold ${getAchievementTextClass(achievementTone)}`}>
              {pctCapaian === null ? '—' : `${pctCapaian.toFixed(2)}%`}
            </span>
          </div>
          <div className="min-w-0 flex flex-col items-center justify-center px-2 py-2">
            <span className="text-[9px] text-slate-500 font-semibold mb-0.5">Gap terhadap target</span>
            <span className={`text-sm font-bold tracking-tight inline-flex items-center gap-1 ${gapRka === null || gapRka === 0 ? 'text-slate-500' : gapRka > 0 ? 'text-emerald-600' : 'text-rose-600'}`} title={!rkaComplete ? targetStatus || undefined : undefined}>
              {gapRka !== null && gapRka > 0 && <ArrowUpRight size={14} strokeWidth={3.25}/>}
              {gapRka !== null && gapRka < 0 && <ArrowDownRight size={14} strokeWidth={3.25}/>}
              {gapRka === null ? '—' : <span title={`Rp ${formatExactAmount(gapRka)}`}>{formatUangDelta(gapRka)}</span>}
            </span>
          </div>
        </div>

        {showPrognosis && <div className="px-3 py-2 border-b border-slate-100">
          <div className="rounded-xl border border-slate-200 grid grid-cols-2 divide-x divide-slate-200 p-2 bg-slate-50/60">
            <div className="min-w-0 flex flex-col items-center justify-center px-1">
              <span className="text-[9px] text-slate-500 font-semibold mb-0.5">Prognosa Oktober</span>
              <span className="text-sm font-extrabold text-slate-700 tracking-tight leading-tight break-words" title={hasProg ? 'M = miliar rupiah; nilai sumber ditampilkan tanpa konversi.' : progStatus}>{hasProg ? formatPrognosisMiliar(progVal) : '—'}</span>
            </div>
            <div className="min-w-0 flex flex-col items-center justify-center px-1">
              <span className="text-[9px] text-slate-500 font-semibold mb-0.5">% Penc. Prognosa</span>
              <span className="text-[8px] text-slate-400 font-medium mb-0.5">Posisi {teksTanggal}</span>
              <span className={`text-base font-extrabold ${getAchievementTextClass(prognosisTone)}`} title={pctPrognosa === null ? progStatus : undefined}>{pctPrognosa === null ? '—' : `${prognosisPercentFormatter.format(pctPrognosa)}%`}</span>
            </div>
          </div>
          {!hasProg && <p className="text-[9px] text-slate-500 mt-1 text-center">Data Prognosa Oktober belum tersedia</p>}
        </div>}

        <div className={`grid ${isAverageMode ? 'grid-cols-3' : 'grid-cols-4'} divide-x divide-slate-200 bg-slate-50/70 mt-auto`}>
          {formatBawah('DTD', dtd)}
          {formatBawah('MTD', mtd)}
          {!isAverageMode && formatBawah('MTM', mtm)}
          {formatBawah('YTD', ytd)}
        </div>
      </div>
    );
  };

  const renderRkaAuditDetails = (entries: Array<{ label: string; result: any }>) => {
    const issues = entries.filter(({ result }) => !result.complete || result.reason || result.diagnostics?.length);
    if (issues.length === 0) return null;
    return (
      <details className="mb-5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 shadow-sm">
        <summary className="cursor-pointer font-bold text-slate-700">Rincian verifikasi RKA ({issues.length} kategori memerlukan perhatian)</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {issues.map(({ label, result }) => (
            <section key={label} className="rounded-lg border border-slate-100 bg-slate-50/70 p-3">
              <h4 className="font-bold text-slate-800">{label}</h4>
              <p className="mt-1">{result.reason || `Cakupan ${result.available ?? 0} dari ${result.total ?? 0} unit.`}</p>
              {typeof result.position === 'number' && typeof result.value === 'number' && <p className="mt-1">Posisi pembanding {formatUangDetail(result.position)} · target pembanding {formatUangDetail(result.value)}</p>}
              {result.diagnostics?.length > 0 && <ul className="mt-1 list-disc pl-4">{result.diagnostics.map((item: string, index: number) => <li key={`${label}-${index}`}>{item}</li>)}</ul>}
            </section>
          ))}
        </div>
      </details>
    );
  };

  const renderDashboardPosisi = () => {
    const rkaSuffix = rkaTargetSuffix;
    const unavailableSegmentTarget = `Target RKA ${selectedSegmen} tidak tersedia sebagai kategori terpisah.`;
    const rkaTabResult = rkaSuffix ? getRkaAggregate(`Tabungan ${rkaSuffix}`) : unavailableRkaResult(unavailableSegmentTarget);
    const rkaDepResult = rkaSuffix ? getRkaAggregate(`Deposito ${rkaSuffix}`) : unavailableRkaResult(unavailableSegmentTarget);
    const rkaGirResult = rkaSuffix ? getRkaAggregate(`Giro ${rkaSuffix}`) : unavailableRkaResult(unavailableSegmentTarget);
    const rkaDpkResult = rkaSuffix === 'Retail Funding'
      ? getRkaAggregate('DPK Retail Funding Total')
      : unavailableRkaResult(selectedSegmen === 'Wholesale' ? 'Kategori target DPK Korporasi tidak tersedia pada tabel RKA.' : `Target DPK ${selectedSegmen} tidak tersedia sebagai kategori terpisah.`);
    const rkaTab = rkaTabResult.value;
    const rkaDep = rkaDepResult.value;
    const rkaGir = rkaGirResult.value;
    const rkaDpk = rkaDpkResult.value;

    return (
      <>
        <div className="min-w-0 bg-white p-3.5 rounded-2xl border border-slate-300 shadow-sm flex flex-col lg:flex-row lg:justify-between lg:items-center gap-3 mb-4">
          <div className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
            <h2 className="min-w-0 break-words text-base sm:text-lg font-black text-slate-800 tracking-tight">Portofolio Simpanan {selectedArea === 'ALL' ? 'Kanwil' : selectedArea.replace('Area ', 'Area ')}</h2>
            <div className="bg-blue-50 text-[#004a8c] px-3 py-1 rounded-lg text-[10px] font-bold flex items-center gap-1.5 border border-blue-200">
              <Calendar size={12}/> Posisi: {teksTanggal}
            </div>
          </div>
          
          <div className="grid w-full min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 lg:flex lg:w-auto lg:flex-wrap">
            <button onClick={() => setSelectedSegmen('Non-Wholesale (Ritel & Mikro)')} className={`min-h-10 min-w-0 rounded-lg border px-2 py-2 text-center text-[9px] leading-tight font-bold transition-colors sm:text-[10px] lg:whitespace-nowrap lg:px-4 lg:py-1.5 ${selectedSegmen.includes('Non-Wholesale') ? 'bg-[#004a8c] text-white border-[#004a8c]' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'}`}>NON WHOLESALE (RITEL + MIKRO)</button>
            <button onClick={() => setSelectedSegmen('Ritel')} className={`min-h-10 min-w-0 rounded-lg border px-2 py-2 text-center text-[9px] leading-tight font-bold transition-colors sm:text-[10px] lg:whitespace-nowrap lg:px-4 lg:py-1.5 ${selectedSegmen === 'Ritel' ? 'bg-[#004a8c] text-white border-[#004a8c]' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'}`}>RITEL</button>
            <button onClick={() => setSelectedSegmen('Mikro')} className={`min-h-10 min-w-0 rounded-lg border px-2 py-2 text-center text-[9px] leading-tight font-bold transition-colors sm:text-[10px] lg:whitespace-nowrap lg:px-4 lg:py-1.5 ${selectedSegmen === 'Mikro' ? 'bg-[#004a8c] text-white border-[#004a8c]' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'}`}>MIKRO</button>
            <button onClick={() => setSelectedSegmen('Wholesale')} className={`min-h-10 min-w-0 rounded-lg border px-2 py-2 text-center text-[9px] leading-tight font-bold transition-colors sm:text-[10px] lg:whitespace-nowrap lg:px-4 lg:py-1.5 ${selectedSegmen === 'Wholesale' ? 'bg-[#004a8c] text-white border-[#004a8c]' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'}`}>WHOLESALE</button>
          </div>
        </div>

        {renderFilterBar()}

        <div className="grid min-w-0 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
          <StatCardV2 
            title="TOTAL DPK" icon={LayoutDashboard} 
            themeCode="#0f172a" textCode="#0f172a" 
            dataVal={engineData.stats.dpk.val} comparisonPosition={rkaDpkResult.position} rkaVal={rkaDpk} rkaComplete={rkaDpkResult.complete} rkaComparedUnits={rkaDpkResult.available} rkaTotalUnits={rkaDpkResult.total} rkaStatus={rkaDpkResult.reason} rkaDiagnostics={rkaDpkResult.diagnostics} progVal={prognosisValues.dpk} progStatus={prognosisStatus} progIsTarget={true} showPrognosis={true} isAverageMode={false} 
            dtd={engineData.stats.dpk.dtd} mtd={engineData.stats.dpk.mtd} mtm={engineData.stats.dpk.mtm} ytd={engineData.stats.dpk.ytd}
          />
          <StatCardV2 
            title="TABUNGAN" icon={Wallet} 
            themeCode="#004a8c" textCode="#004a8c" 
            dataVal={engineData.stats.tabungan.val} comparisonPosition={rkaTabResult.position} rkaVal={rkaTab} rkaComplete={rkaTabResult.complete} rkaComparedUnits={rkaTabResult.available} rkaTotalUnits={rkaTabResult.total} rkaStatus={rkaTabResult.reason} rkaDiagnostics={rkaTabResult.diagnostics} progVal={prognosisValues.tabungan} progStatus={prognosisStatus} progIsTarget={true} showPrognosis={true} isAverageMode={false} 
            dtd={engineData.stats.tabungan.dtd} mtd={engineData.stats.tabungan.mtd} mtm={engineData.stats.tabungan.mtm} ytd={engineData.stats.tabungan.ytd}
          />
          <StatCardV2 
            title="DEPOSITO" icon={Banknote} 
            themeCode="#0f8b65" textCode="#0f8b65" 
            dataVal={engineData.stats.deposito.val} comparisonPosition={rkaDepResult.position} rkaVal={rkaDep} rkaComplete={rkaDepResult.complete} rkaComparedUnits={rkaDepResult.available} rkaTotalUnits={rkaDepResult.total} rkaStatus={rkaDepResult.reason} rkaDiagnostics={rkaDepResult.diagnostics} progVal={prognosisValues.deposito} progStatus={prognosisStatus} progIsTarget={true} showPrognosis={true} isAverageMode={false} 
            dtd={engineData.stats.deposito.dtd} mtd={engineData.stats.deposito.mtd} mtm={engineData.stats.deposito.mtm} ytd={engineData.stats.deposito.ytd}
          />
          <StatCardV2 
            title="GIRO" icon={PieChart} 
            themeCode="#8b5cf6" textCode="#8b5cf6" 
            dataVal={engineData.stats.giro.val} comparisonPosition={rkaGirResult.position} rkaVal={rkaGir} rkaComplete={rkaGirResult.complete} rkaComparedUnits={rkaGirResult.available} rkaTotalUnits={rkaGirResult.total} rkaStatus={rkaGirResult.reason} rkaDiagnostics={rkaGirResult.diagnostics} progVal={prognosisValues.giro} progStatus={prognosisStatus} progIsTarget={true} showPrognosis={true} isAverageMode={false} 
            dtd={engineData.stats.giro.dtd} mtd={engineData.stats.giro.mtd} mtm={engineData.stats.giro.mtm} ytd={engineData.stats.giro.ytd}
          />
        </div>
        <div className="min-w-0 bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-300 mb-6">
          <div className="flex flex-col lg:flex-row justify-between gap-4 mb-2">
            <h3 className="text-sm text-slate-800 flex items-center gap-2 font-black tracking-tight">
              Trend Summary (Bulanan)
            </h3>
          </div>
          <div className="grid min-w-0 grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="min-w-0 border border-slate-200 p-3 rounded-xl bg-slate-50/50">
              <h4 className="text-[10px] font-black text-slate-800 uppercase tracking-widest text-center mb-1">TOTAL DPK</h4>
              {renderSummaryChart(engineData.rawSummary.dpk, '#0f172a')}
            </div>
            <div className="min-w-0 border border-slate-200 p-3 rounded-xl bg-slate-50/50">
              <h4 className="text-[10px] font-black text-[#004a8c] uppercase tracking-widest text-center mb-1">TABUNGAN</h4>
              {renderSummaryChart(engineData.rawSummary.tabungan, '#004a8c')}
            </div>
            <div className="min-w-0 border border-slate-200 p-3 rounded-xl bg-slate-50/50">
              <h4 className="text-[10px] font-black text-[#8b5cf6] uppercase tracking-widest text-center mb-1">GIRO</h4>
              {renderSummaryChart(engineData.rawSummary.giro, '#8b5cf6')}
            </div>
            <div className="min-w-0 border border-slate-200 p-3 rounded-xl bg-slate-50/50">
              <h4 className="text-[10px] font-black text-[#0f8b65] uppercase tracking-widest text-center mb-1">DEPOSITO</h4>
              {renderSummaryChart(engineData.rawSummary.deposito, '#0f8b65')}
            </div>
          </div>
        </div>

        <div className="min-w-0 bg-white p-4 sm:p-5 rounded-2xl shadow-sm border border-slate-300 mb-6">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 mb-5 border-b border-slate-100 pb-4">
            <h3 className="text-sm text-slate-800 flex items-center gap-2 font-black tracking-tight">
              Trend Visual (Harian)
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={handleResetLegend} className="px-3 py-1 rounded-lg text-[9px] uppercase tracking-widest font-bold flex items-center gap-1.5 cursor-pointer transition-all bg-slate-100 text-slate-600 hover:bg-slate-200 mr-2 border border-slate-200">
                <RotateCcw size={12} /> <span className="hidden sm:inline">Reset Garis</span>
              </button>
              <div className="flex items-center bg-slate-50 p-1 rounded-lg border border-slate-200">
                <button onClick={() => setChartViewMode('grid')} className={`px-3 py-1 rounded-md text-[9px] uppercase tracking-widest font-bold flex items-center gap-1.5 cursor-pointer transition-all ${chartViewMode === 'grid' ? 'bg-[#004a8c] text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'}`}>
                  <Layers size={12} /> <span className="hidden sm:inline">Grid 4 Kotak</span>
                </button>
                <button onClick={() => setChartViewMode('focus')} className={`px-3 py-1 rounded-md text-[9px] uppercase tracking-widest font-bold flex items-center gap-1.5 cursor-pointer transition-all ${chartViewMode === 'focus' ? 'bg-[#004a8c] text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'}`}>
                  <Eye size={12} /> <span className="hidden sm:inline">Fokus 1 Kotak</span>
                </button>
              </div>
            </div>
          </div>

          {chartViewMode === 'grid' ? (
            <div className="grid min-w-0 grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="border border-slate-200 p-3 rounded-xl"><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-widest ml-2">Total DPK</h4>{renderChart('dpk', engineData.charts.dpk, '#0f172a')}</div>
              <div className="border border-slate-200 p-3 rounded-xl"><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-widest ml-2">Tabungan</h4>{renderChart('tabungan', engineData.charts.tabungan, '#004a8c')}</div>
              <div className="border border-slate-200 p-3 rounded-xl"><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-widest ml-2">Giro</h4>{renderChart('giro', engineData.charts.giro, '#8b5cf6')}</div>
              <div className="border border-slate-200 p-3 rounded-xl"><h4 className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-widest ml-2">Deposito</h4>{renderChart('deposito', engineData.charts.deposito, '#0f8b65')}</div>
            </div>
          ) : (
            <div className="bg-slate-50/50 p-3 rounded-2xl border border-slate-200">
              <div className="flex gap-2 mb-3 overflow-x-auto pb-1 scrollbar-hide">
                {[{ key: 'dpk', label: 'Total DPK', col: '#0f172a' }, { key: 'tabungan', label: 'Tabungan', col: '#004a8c' }, { key: 'giro', label: 'Giro', col: '#8b5cf6' }, { key: 'deposito', label: 'Deposito', col: '#0f8b65' }].map((t) => (
                  <button key={t.key} onClick={() => setActiveCard(t.key as ProductKey)} className={`px-4 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold cursor-pointer transition-all whitespace-nowrap ${activeCard === t.key ? 'text-white shadow-sm' : 'bg-white text-slate-500 border border-slate-200'}`} style={activeCard === t.key ? { backgroundColor: t.col } : {}}>
                    {t.label}
                  </button>
                ))}
              </div>
              {renderChart(activeCard, engineData.charts[activeCard], activeCard === 'dpk' ? '#0f172a' : activeCard === 'tabungan' ? '#004a8c' : activeCard === 'giro' ? '#8b5cf6' : '#0f8b65')}
            </div>
          )}
        </div>
      </>
    );
  };

  const renderDashboardMarginal = () => {
    const averageSuffix = rkaTargetSuffix || selectedSegmen;
    const rkaAvgTabResult = rkaTargetSuffix ? getRkaAggregate(`Average daily Tabungan ${averageSuffix}`) : unavailableRkaResult(`Target Average Daily ${selectedSegmen} tidak tersedia sebagai kategori terpisah pada RKA.`);
    const rkaAvgDepResult = rkaTargetSuffix ? getRkaAggregate(`Average daily Deposito ${averageSuffix}`) : unavailableRkaResult(`Target Average Daily ${selectedSegmen} tidak tersedia sebagai kategori terpisah pada RKA.`);
    const rkaAvgGirResult = rkaTargetSuffix ? getRkaAggregate(`Average daily Giro ${averageSuffix}`) : unavailableRkaResult(`Target Average Daily ${selectedSegmen} tidak tersedia sebagai kategori terpisah pada RKA.`);
    const rkaAvgDpkResult = rkaTargetSuffix === 'Retail Funding'
      ? getRkaAggregate('Average daily Simpanan Retail Funding Total')
      : unavailableRkaResult(selectedSegmen === 'Wholesale' ? 'Kategori target Average Daily DPK Korporasi tidak tersedia pada tabel RKA.' : `Target Average Daily DPK ${selectedSegmen} tidak tersedia sebagai kategori terpisah.`);
    const rkaAvgTab = rkaAvgTabResult.value;
    const rkaAvgDep = rkaAvgDepResult.value;
    const rkaAvgGir = rkaAvgGirResult.value;
    const averagePositionStatus = (product: ProductKey) => {
      const availableDays = engineData.averages.monthlyDatesAvailable[product];
      const requiredDays = engineData.averages.daysInMonth;
      return availableDays < requiredDays
        ? `Data posisi aktual tercatat pada ${availableDays} dari ${requiredDays} hari. Rata-rata bulanan belum dapat dihitung.`
        : `Data posisi aktual belum lengkap untuk seluruh unit pada ${requiredDays} hari yang disyaratkan.`;
    };
    const averageCoverage = (result: any) => ({
      rkaComparedUnits: result.available,
      rkaTargetUnits: result.targetAvailable,
      rkaTotalUnits: result.total,
      averagePositionCoverage: `${result.available}/${result.total} unit pembanding`,
      averageTargetCoverage: `${result.targetAvailable}/${result.total} unit target valid`
    });
    const rkaAvgDpk = rkaAvgDpkResult.value;
    const selectedMonth = selectedPeriode.slice(0, 7);
    const [selectedYear, selectedMonthNumber] = selectedMonth.split('-').map(Number);
    const monthLabel = `${namaBulanIndo[(selectedMonthNumber || 1) - 1]} ${selectedYear || ''}`;
    const rowsPerPage = 15;
    const filteredAverageRows = averageRows.filter((row: any) => !averageSearch || `${row.name} ${row.branch} ${row.code || ''}`.toUpperCase().includes(averageSearch.toUpperCase()));
    const pageCount = Math.max(1, Math.ceil(filteredAverageRows.length / rowsPerPage));
    const safePage = Math.min(averagePage, pageCount);
    const visibleAverageRows = filteredAverageRows.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage);
    const comparisonCategories = [
      { key: 'dpk' as ProductKey, label: 'Total DPK', result: rkaAvgDpkResult },
      { key: 'tabungan' as ProductKey, label: 'Tabungan', result: rkaAvgTabResult },
      { key: 'deposito' as ProductKey, label: 'Deposito', result: rkaAvgDepResult },
      { key: 'giro' as ProductKey, label: 'Giro', result: rkaAvgGirResult }
    ];
    const chartTrend = averageTrend.filter(point => point.actual !== null || point.target !== null);
    const averageTargetCategory = averageTableProduct === 'dpk'
      ? `A Average daily Simpanan ${averageSuffix} Total`
      : `A Average daily ${averageTableProduct === 'tabungan' ? 'Tabungan' : averageTableProduct === 'deposito' ? 'Deposito' : 'Giro'} ${averageSuffix}`;
    const hasAverageTarget = averageTrend.some(point => point.target !== null);
    const changeMonth = (month: string) => {
      const lastDay = availableMonths.get(month);
      if (!lastDay) return;
      setSelectedPeriode(`${month}-${String(lastDay).padStart(2, '0')}`);
      setAveragePage(1);
    };

    return (
      <>
        <div className="bg-white p-3.5 rounded-2xl border border-slate-300 shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
          <div className="min-w-0">
            <h2 className="text-lg font-black text-slate-800 tracking-tight">Dashboard Marginal</h2>
            <p className="text-xs font-semibold text-slate-600">Periode: {monthLabel}</p>
            <p className="mt-1 text-[10px] text-slate-500">Data posisi DPK tersedia {engineData.averages.monthlyDatesAvailable.dpk}/{engineData.averages.daysInMonth} tanggal; rata-rata bulanan memerlukan data lengkap.</p>
          </div>
          <label className="text-[10px] text-slate-500 font-semibold flex items-center gap-2">Pilih bulan
            <select value={selectedMonth} onChange={(e) => changeMonth(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1.5 text-[11px] text-slate-700">
              {[...availableMonths.keys()].sort().map(month => <option key={month} value={month}>{namaBulanIndo[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}</option>)}
            </select>
          </label>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-5">
          <StatCardV2 
            title="AVERAGE TOTAL DPK" icon={LayoutDashboard} 
            themeCode="#0f172a" textCode="#0f172a" 
            dataVal={rkaAvgDpkResult.position} comparisonPosition={rkaAvgDpkResult.position} rkaVal={rkaAvgDpk} rkaComplete={rkaAvgDpkResult.complete} {...averageCoverage(rkaAvgDpkResult)} averagePositionStatus={averagePositionStatus('dpk')} rkaStatus={rkaAvgDpkResult.reason} rkaDiagnostics={rkaAvgDpkResult.diagnostics} progVal={null} isAverageMode={true} dtd={engineData.averages.movement.dpk.dtd} mtd={engineData.averages.movement.dpk.mtd} ytd={engineData.averages.movement.dpk.ytd} onClick={() => { setAverageTableProduct('dpk'); setAveragePage(1); }}
          />
          <StatCardV2 
            title="AVERAGE TABUNGAN" icon={Wallet} 
            themeCode="#004a8c" textCode="#004a8c" 
            dataVal={rkaAvgTabResult.position} comparisonPosition={rkaAvgTabResult.position} rkaVal={rkaAvgTab} rkaComplete={rkaAvgTabResult.complete} {...averageCoverage(rkaAvgTabResult)} averagePositionStatus={averagePositionStatus('tabungan')} rkaStatus={rkaAvgTabResult.reason} rkaDiagnostics={rkaAvgTabResult.diagnostics} progVal={null} isAverageMode={true} dtd={engineData.averages.movement.tabungan.dtd} mtd={engineData.averages.movement.tabungan.mtd} ytd={engineData.averages.movement.tabungan.ytd} onClick={() => { setAverageTableProduct('tabungan'); setAveragePage(1); }}
          />
          <StatCardV2 
            title="AVERAGE DEPOSITO" icon={Banknote} 
            themeCode="#0f8b65" textCode="#0f8b65" 
            dataVal={rkaAvgDepResult.position} comparisonPosition={rkaAvgDepResult.position} rkaVal={rkaAvgDep} rkaComplete={rkaAvgDepResult.complete} {...averageCoverage(rkaAvgDepResult)} averagePositionStatus={averagePositionStatus('deposito')} rkaStatus={rkaAvgDepResult.reason} rkaDiagnostics={rkaAvgDepResult.diagnostics} progVal={null} isAverageMode={true} dtd={engineData.averages.movement.deposito.dtd} mtd={engineData.averages.movement.deposito.mtd} ytd={engineData.averages.movement.deposito.ytd} onClick={() => { setAverageTableProduct('deposito'); setAveragePage(1); }}
          />
          <StatCardV2 
            title="AVERAGE GIRO" icon={PieChart} 
            themeCode="#8b5cf6" textCode="#8b5cf6" 
            dataVal={rkaAvgGirResult.position} comparisonPosition={rkaAvgGirResult.position} rkaVal={rkaAvgGir} rkaComplete={rkaAvgGirResult.complete} {...averageCoverage(rkaAvgGirResult)} averagePositionStatus={averagePositionStatus('giro')} rkaStatus={rkaAvgGirResult.reason} rkaDiagnostics={rkaAvgGirResult.diagnostics} progVal={null} isAverageMode={true} dtd={engineData.averages.movement.giro.dtd} mtd={engineData.averages.movement.giro.mtd} ytd={engineData.averages.movement.giro.ytd} onClick={() => { setAverageTableProduct('giro'); setAveragePage(1); }}
          />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 mb-5">
          <section className="xl:col-span-3 bg-white rounded-2xl border border-slate-200 shadow-sm p-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div><h3 className="font-bold text-sm text-slate-800">Tren saldo harian</h3><p className="text-[10px] text-slate-500">Target ditampilkan untuk unit dengan target valid; saldo aktual hanya tersedia setelah data harian satu bulan lengkap.</p><p className="mt-1 text-[10px] text-slate-400">Sumber target: {hasAverageTarget ? <>MySQL · {averageTargetCategory} · {selectedMonth}</> : <>Target {averageTargetCategory} belum tersedia untuk periode ini</>}</p></div>
              <select value={averageTableProduct} onChange={(e) => { setAverageTableProduct(e.target.value as ProductKey); setAveragePage(1); }} className="border border-slate-300 rounded-lg px-2 py-1.5 text-[11px]">
                <option value="dpk">Total DPK</option><option value="tabungan">Tabungan</option><option value="deposito">Deposito</option><option value="giro">Giro</option>
              </select>
            </div>
            {!averageTrend.some(point => point.actual !== null) && <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-[10px] text-amber-800">Data posisi aktual tercatat pada {engineData.averages.monthlyDatesAvailable[averageTableProduct]} dari {engineData.averages.daysInMonth} hari. Rata-rata bulanan belum dapat dihitung.</p>}
            {chartTrend.length > 0 ? <div className="h-64">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={chartTrend} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="day" tick={{ fontSize: 10 }} tickFormatter={(day) => String(day).padStart(2, '0')} label={{ value: `Tanggal ${selectedMonth}`, position: 'insideBottom', offset: -4 }} /><YAxis tick={{ fontSize: 10 }} tickFormatter={(value) => formatCompactAmount(Number(value))} width={72} domain={['auto', 'auto']} />
                <Tooltip formatter={(value, name) => [typeof value === 'number' && Number.isFinite(value) ? `Rp ${formatCompactAmount(value)}` : '—', String(name)]} labelFormatter={(day) => `Tanggal ${day} ${selectedMonth}`} />
                <Legend wrapperStyle={{ fontSize: 11 }} /><Line type="monotone" dataKey="actual" name="Saldo aktual" stroke="#004a8c" strokeWidth={2.5} dot={false} connectNulls={false} />{hasAverageTarget && <Line type="monotone" dataKey="target" name="Target Average Daily" stroke="#f59e0b" strokeDasharray="5 4" dot={false} />}
              </LineChart></ResponsiveContainer>
            </div> : <div className="h-64 flex flex-col items-center justify-center gap-2 px-4 text-center text-xs text-slate-500"><span>{hasAverageTarget ? 'Belum ada rangkaian saldo harian lengkap pada cakupan unit pembanding.' : `Target Average Daily untuk ${averageTargetCategory} belum tersedia pada ${selectedMonth}.`}</span><span className="text-[10px] text-slate-400">Grafik hanya menampilkan snapshot yang tersedia; tidak ada saldo atau target yang diperkirakan.</span></div>}
          </section>
          <section className="xl:col-span-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <h3 className="font-bold text-sm text-slate-800 mb-1">Pencapaian per kategori</h3><p className="text-[10px] text-slate-500 mb-4">Pilih kategori untuk memfilter tabel rincian.</p>
            <div className="space-y-3">{comparisonCategories.map(item => {
              const pct = item.result.value && item.result.position !== null ? item.result.position / item.result.value * 100 : null;
              const tone = getAchievementTone(pct);
              const width = pct === null ? 0 : Math.min(100, Math.max(0, pct));
              const barColor = tone === 'achieved' ? 'bg-emerald-500' : tone === 'near-target' ? 'bg-amber-400' : tone === 'below-target' ? 'bg-rose-500' : 'bg-slate-300';
              return <button key={item.key} onClick={() => { setAverageTableProduct(item.key); setAveragePage(1); }} className="w-full text-left group">
                <div className="flex justify-between text-[11px] font-semibold mb-1"><span className="text-slate-700 group-hover:text-[#004a8c]">{item.label}</span><span className={getAchievementTextClass(tone)}>{pct === null ? '—' : `${pct.toFixed(1)}%`}</span></div>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${barColor}`} style={{ width: `${width}%` }} /></div>
                <div className="text-[9px] text-slate-400 mt-1">{item.result.available}/{item.result.total} unit dapat dibandingkan</div>
              </button>;
            })}</div>
          </section>
        </div>
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden mb-5">
          <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-100">
            <div><h3 className="font-bold text-sm text-slate-800">Rincian unit kerja</h3><p className="text-[10px] text-slate-500">Average {averageTableProduct === 'dpk' ? 'Total DPK' : averageTableProduct}; urutkan dengan menekan nama unit.</p></div>
            <div className="flex gap-2"><div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"/><input value={averageSearch} onChange={(e) => { setAverageSearch(e.target.value); setAveragePage(1); }} placeholder="Cari unit/cabang/kode" className="pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-[11px] w-full sm:w-60"/></div>
              <button onClick={() => setAverageSortAsc(value => !value)} className="px-3 py-2 border border-slate-300 rounded-lg text-[11px] font-semibold flex items-center gap-1"><ArrowUpDown size={13}/>Nama</button></div>
          </div>
          <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-4 py-3">Unit / Cabang</th><th className="px-4 py-3 text-right">Average aktual</th><th className="px-4 py-3 text-right">Target Average</th><th className="px-4 py-3 text-right">Capaian</th><th className="px-4 py-3 text-right">Gap</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{visibleAverageRows.map((row: any) => <tr key={`${row.branch}-${row.name}`} onClick={() => setSelectedUkerModal(row.unit)} className="hover:bg-slate-50 cursor-pointer"><td className="px-4 py-3"><div className="font-semibold text-slate-800">{row.name}</div><div className="text-[10px] text-slate-500">{row.branch} · {row.code || 'kode —'}</div></td><td className="px-4 py-3 text-right font-semibold" title={row.actual === null ? row.status : `Rp ${formatExactAmount(row.actual)}`}>{row.actual === null ? '—' : formatCompactAmount(row.actual)}</td><td className="px-4 py-3 text-right" title={row.target === null ? row.status : `Rp ${formatExactAmount(row.target)}`}>{row.target === null ? '—' : formatCompactAmount(row.target)}</td><td className={`px-4 py-3 text-right font-bold ${getAchievementTextClass(getAchievementTone(row.percentage))}`}>{row.percentage === null ? '—' : `${row.percentage.toFixed(2)}%`}</td><td className="px-4 py-3 text-right">{row.gap === null ? '—' : formatCompactAmount(row.gap)}</td></tr>)}</tbody>
          </table></div>
          <div className="px-4 py-3 flex items-center justify-between border-t border-slate-100 text-[10px] text-slate-500"><span>{filteredAverageRows.length} unit dalam hasil filter</span><div className="flex items-center gap-2"><button disabled={safePage <= 1} onClick={() => setAveragePage(safePage - 1)} className="px-2.5 py-1 border rounded disabled:opacity-40">Sebelumnya</button><span>{safePage} / {pageCount}</span><button disabled={safePage >= pageCount} onClick={() => setAveragePage(safePage + 1)} className="px-2.5 py-1 border rounded disabled:opacity-40">Berikutnya</button></div></div>
        </section>
        {renderRkaAuditDetails([
          { label: 'Average Total DPK', result: rkaAvgDpkResult },
          { label: 'Average Tabungan', result: rkaAvgTabResult },
          { label: 'Average Deposito', result: rkaAvgDepResult },
          { label: 'Average Giro', result: rkaAvgGirResult }
        ])}
      </>
    )
  }

const renderDashboardAppraisal = () => {
  const periodLabel = (source: AppraisalSource | null) => source
    ? `${namaBulanIndo[Number(source.month) - 1]} ${source.year} — ${source.type}`
    : 'Periode tidak tersedia';
  const selectedRecordMessage = appraisalApiStatus === 'loading-sources'
    ? 'Memuat periode appraisal dari spreadsheet…'
    : appraisalApiStatus === 'loading-data'
      ? 'Memuat record appraisal untuk periode terpilih…'
      : appraisalApiStatus === 'error'
        ? appraisalApiError
        : appraisalSourcesLoaded && appraisalSources.length === 0
          ? 'Spreadsheet belum menyediakan tab Master Data RO/KP yang dikenali.'
          : appraisalApiStatus === 'ready' && appraisalRecordCount === 0
            ? 'Tab appraisal terpilih tidak memiliki record.'
            : selectedAppraisalRecords.length > 1
              ? 'PN memiliki lebih dari satu record pada sumber ini; data tidak ditampilkan karena hasilnya ambigu.'
              : selectedAppraisalRm && appraisalApiStatus === 'ready' && !selectedAppraisalRecord
                ? 'RM terpilih tidak ditemukan berdasarkan PN pada sumber appraisal ini.'
                : '';
  const scoreValue = selectedAppraisalRecord?.Score;
  const tierValue = selectedAppraisalRecord?.Tier;
  const totalScoreLabel = typeof scoreValue === 'number' && Number.isFinite(scoreValue)
    ? formatAppraisalNumber(scoreValue) : '—';
  const appraisalMetricsRows = selectedAppraisalRecord ? APPRAISAL_METRICS.map(metric => {
    const targetValue = selectedAppraisalRecord[metric.target];
    const targetMissing = targetValue === null || targetValue === undefined || targetValue === '';
    const availability = selectedAppraisalRecord.targetAvailability?.[metric.name];
    return { metric, targetValue, targetMissing, availability };
  }) : [];

  return (
  <div className="mx-auto w-full max-w-[1720px] space-y-5">
    <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_4px_18px_-12px_rgba(15,35,69,0.22)] sm:p-5">
      <div className="mb-4 flex flex-col gap-1 border-b border-slate-100 pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h2 className="text-xl font-extrabold tracking-tight text-slate-900">Appraisal RM</h2><p className="mt-1 text-xs text-slate-500">Pilih profil dan periode untuk melihat hasil appraisal dari spreadsheet.</p></div>
        <span className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-800 sm:mt-0"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>Sumber read-only</span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="flex min-w-0 flex-col gap-1.5 text-[10px] font-bold text-slate-600"><span>Cari RM</span><span className="relative"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><input value={appraisalSearchDraft} onChange={event => setAppraisalSearchDraft(event.target.value)} placeholder="Nama atau PN" className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/70 py-2 pl-9 pr-3 text-xs font-medium text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100"/></span></label>
        <label className="flex min-w-0 flex-col gap-1.5 text-[10px] font-bold text-slate-600"><span>KC</span><select value={appraisalKc} onChange={event => setAppraisalKc(event.target.value)} className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3 text-xs font-medium text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100"><option value="ALL">Semua KC</option>{appraisalKcs.map(kc => <option key={kc.code} value={kc.code}>{kc.name} · {kc.code}</option>)}</select></label>
        <label className="flex min-w-0 flex-col gap-1.5 text-[10px] font-bold text-slate-600"><span>Kategori jabatan</span><select value={appraisalRole} onChange={event => setAppraisalRole(event.target.value)} className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3 text-xs font-medium text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100"><option value="ALL">Semua kategori RM</option>{appraisalRoles.map(role => <option key={role} value={role}>{role}</option>)}</select></label>
        <label className="flex min-w-0 flex-col gap-1.5 text-[10px] font-bold text-slate-600"><span>Periode appraisal</span><select value={selectedAppraisalSourceKey} disabled={appraisalApiStatus === 'loading-sources' || appraisalSources.length === 0} onChange={event => setSelectedAppraisalSourceKey(event.target.value)} className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3 text-xs font-medium text-slate-800 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100">
            {appraisalSources.length === 0 && <option value="">{appraisalApiStatus === 'loading-sources' ? 'Memuat periode…' : 'Periode tidak tersedia'}</option>}
            {appraisalSources.map(source => <option key={appraisalSourceKey(source)} value={appraisalSourceKey(source)}>{periodLabel(source)}</option>)}
          </select>
        </label>
      </div>
    </header>

    {(appraisalApiStatus === 'loading-sources' || appraisalApiStatus === 'loading-data' || appraisalApiStatus === 'error' || (appraisalSourcesLoaded && appraisalSources.length === 0)) && <div role={appraisalApiStatus === 'error' ? 'alert' : 'status'} className={`flex flex-col gap-3 rounded-xl border px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between ${appraisalApiStatus === 'error' ? 'border-rose-200 bg-rose-50/80 text-rose-800' : 'border-blue-100 bg-blue-50/70 text-blue-800'}`}>
      <span>{appraisalApiStatus === 'error' ? appraisalApiError : appraisalApiStatus === 'loading-sources' ? 'Menghubungkan ke sumber appraisal…' : appraisalApiStatus === 'loading-data' ? `Memuat data ${periodLabel(selectedAppraisalSource)}…` : 'Tidak ada periode appraisal yang tersedia dari API.'}</span>
      {appraisalApiStatus === 'error' && <button disabled={appraisalRetryNotBefore > appraisalRetryClock} onClick={() => { appraisalFetchBlockedAfterError.current = false; setAppraisalApiError(''); setAppraisalApiStatus('idle'); setAppraisalRetryToken(token => token + 1); }} className="w-fit rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[11px] font-bold text-rose-700 transition hover:bg-rose-100 disabled:cursor-wait disabled:opacity-60">{appraisalRetryNotBefore > appraisalRetryClock ? `Coba lagi dalam ${Math.ceil((appraisalRetryNotBefore - appraisalRetryClock) / 1000)} dtk` : 'Coba lagi'}</button>}
    </div>}

    <section aria-label="Statistik produktivitas RMFT" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {[
        { label: 'Total RMFT', value: appraisalTierStats?.total ?? filteredAppraisalProfiles.length, detail: 'Profil RMFT pada cakupan saat ini', style: 'border-blue-100 bg-blue-50/50 text-blue-800' },
        { label: 'Produktif · Tier 1–2', value: appraisalTierStats ? `${appraisalTierStats.productive} · ${appraisalTierStats.productivePct === null ? '—' : `${appraisalTierStats.productivePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`}` : '—', detail: 'Persentase dari RMFT dengan Tier valid', style: 'border-emerald-100 bg-emerald-50/50 text-emerald-800' },
        { label: 'Tidak produktif · Tier 3–4', value: appraisalTierStats ? `${appraisalTierStats.unproductive} · ${appraisalTierStats.unproductivePct === null ? '—' : `${appraisalTierStats.unproductivePct.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`}` : '—', detail: 'Persentase dari RMFT dengan Tier valid', style: 'border-amber-100 bg-amber-50/50 text-amber-800' },
        { label: 'Belum memiliki Tier', value: appraisalTierStats?.unassessed ?? (appraisalDataReady ? 0 : '—'), detail: appraisalTierStats ? `${appraisalTierStats.tiered} RMFT memiliki Tier valid` : 'Menunggu data periode appraisal', style: 'border-slate-200 bg-slate-50 text-slate-700' },
      ].map(item => <article key={item.label} className={`min-w-0 rounded-xl border p-3 ${item.style}`}><p className="text-[10px] font-bold leading-4">{item.label}</p><p className="mt-1 text-lg font-extrabold tabular-nums">{item.value}</p><p className="mt-1 text-[9px] leading-4 opacity-75">{item.detail}</p></article>)}
    </section>

    <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-12">
      <AppraisalRmList profiles={sortedAppraisalProfiles} selectedPn={selectedAppraisalPn} onSelect={handleSelectAppraisalRm} tierByPn={appraisalTierByPn}/>

      <section className="min-w-0 space-y-4 xl:col-span-9">
        {!selectedAppraisalRm ? <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center shadow-sm"><span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-700"><User size={22}/></span><h3 className="mt-4 text-sm font-bold text-slate-800">Pilih RM untuk melihat profil</h3><p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">Score, tier, dan rincian KPI dibaca dari record spreadsheet untuk PN yang dipilih.</p></div> : <>
          {selectedRecordMessage && <section role={appraisalApiStatus === 'error' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-xs ${appraisalApiStatus === 'error' ? 'border-rose-200 bg-rose-50/70 text-rose-800' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
            {appraisalApiStatus === 'loading-data' || appraisalApiStatus === 'loading-sources' ? <Loader2 size={14} className="mr-2 inline animate-spin"/> : <Info size={14} className="mr-2 inline"/>}{selectedRecordMessage}
          </section>}

          <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="min-w-0 space-y-3 xl:col-span-4">
              <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Profil RM</p>
                <div className="flex min-w-0 flex-col items-center gap-4 sm:flex-row sm:items-start">
                  <AppraisalRmPhoto name={selectedAppraisalRm.name} />
                  <div className="min-w-0 flex-1 text-center sm:text-left">
                    <h3 className="flex flex-wrap items-center justify-center gap-1.5 break-words text-base font-extrabold leading-5 text-slate-900 sm:justify-start">{selectedAppraisalRm.name}<span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-bold ${tierBadgeClass(appraisalTierByPn[selectedAppraisalRm.pn] ?? null)}`}>{appraisalTierByPn[selectedAppraisalRm.pn] ? `Tier ${appraisalTierByPn[selectedAppraisalRm.pn]}` : 'Belum dinilai'}</span></h3>
                    <p className="mt-1 break-words text-xs font-medium text-slate-600">PN {selectedAppraisalRm.pn}</p>
                    <p className="mt-1 break-words text-xs text-slate-500">{selectedAppraisalRm.role || 'Jabatan tidak tersedia'}</p>
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-t border-slate-100 pt-3">
                  {[
                    ['Kantor / unit', selectedAppraisalRm.unitName || 'Belum terpetakan'],
                    ['Kode Uker', selectedAppraisalRm.unitCode || '—'],
                    ['JG', selectedAppraisalRm.grade || '—'],
                  ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[10px] text-slate-500">{label}</dt><dd className="mt-0.5 break-words text-xs font-semibold text-slate-800">{value}</dd></div>)}
                </dl>
              </article>

              <section className="grid grid-cols-2 gap-3">
                <article className="min-w-0 rounded-2xl border border-blue-100 bg-white p-3.5 shadow-sm">
                  <div className="flex items-center gap-2 text-blue-700"><Award size={16}/><h3 className="text-[10px] font-bold uppercase tracking-wide">Total Score</h3></div>
                  <p className="mt-2 break-words text-xl font-extrabold tabular-nums text-slate-900">{appraisalApiStatus === 'loading-data' || appraisalApiStatus === 'loading-sources' ? 'Memuat…' : totalScoreLabel}</p>
                  <p className="mt-2 border-t border-slate-100 pt-2 text-[10px] text-slate-500">Periode: <span className="font-semibold text-slate-700">{periodLabel(selectedAppraisalSource)}</span></p>
                </article>
                <article className="min-w-0 rounded-2xl border border-violet-100 bg-white p-3.5 shadow-sm">
                  <div className="flex items-center gap-2 text-violet-700"><Layers size={16}/><h3 className="text-[10px] font-bold uppercase tracking-wide">Tier</h3></div>
                  <p className={`mt-2 break-words text-xl font-extrabold ${typeof tierValue === 'string' && tierValue.trim() ? 'text-slate-900' : 'text-slate-400'}`}>{appraisalApiStatus === 'loading-data' || appraisalApiStatus === 'loading-sources' ? 'Memuat…' : typeof tierValue === 'string' && tierValue.trim() ? tierValue : 'Tidak tersedia'}</p>
                </article>
              </section>
            </div>

            <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm xl:col-span-8 xl:h-[calc(100dvh-19rem)] xl:max-h-[760px] xl:overflow-y-auto">
              <div className="border-b border-slate-100 px-3.5 py-2.5 sm:px-4"><h3 className="text-sm font-extrabold text-slate-900">Rincian KPI</h3><p className="mt-0.5 text-[11px] leading-4 text-slate-500">Target, realisasi, persentase, dan score dari spreadsheet.</p></div>
              <div className="grid min-w-0 grid-cols-1 gap-2.5 p-3 sm:grid-cols-2 xl:grid-cols-3">
                {appraisalApiStatus === 'loading-data' || appraisalApiStatus === 'loading-sources' ? <div className="col-span-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500"><Loader2 size={15} className="mr-2 inline animate-spin"/>Memuat rincian KPI…</div>
                  : appraisalApiStatus === 'error' ? <div className="col-span-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-8 text-center text-xs text-rose-700">{appraisalApiError}</div>
                    : !selectedAppraisalRecord ? <div className="col-span-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-xs text-slate-500">{selectedRecordMessage || 'Pilih periode dan RM yang tersedia untuk melihat rincian KPI.'}</div>
                      : appraisalMetricsRows.map(({ metric, targetValue, targetMissing, availability }) => {
                        const accent = KPI_ACCENT_STYLES[metric.accent];
                        const actualValue = selectedAppraisalRecord[metric.actual];
                        const realizationValue = selectedAppraisalRecord[metric.realization];
                        const score = selectedAppraisalRecord[metric.score];
                        const progressWidth = typeof realizationValue === 'number' && Number.isFinite(realizationValue)
                          ? Math.max(0, Math.min(100, realizationValue * 100)) : 0;
                        return <article key={metric.name} className="relative flex h-[184px] min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white p-3 pt-4 shadow-[0_2px_8px_rgba(15,35,69,0.035)] transition-colors hover:border-slate-300">
                          <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 ${accent.line}`}/>
                          <div className="flex min-w-0 items-start justify-between gap-2 border-b border-slate-100 pb-2">
                            <h4 title={metric.name} className="line-clamp-2 min-h-8 min-w-0 flex-1 text-xs font-bold leading-4 text-slate-800">{metric.name}</h4>
                            <div className={`shrink-0 rounded-lg px-1.5 py-1 text-right ${accent.score}`}><span className={`block text-[9px] font-bold uppercase tracking-wide ${accent.scoreLabel}`}>Score</span><span className="mt-0.5 block text-xs font-extrabold tabular-nums">{formatAppraisalNumber(score)}</span></div>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <div className="min-w-0"><p className="text-[10px] font-medium text-slate-500">Target</p><p title={targetMissing ? `Target tidak tersedia${availability === 'not_available' ? ' pada sumber appraisal ini' : ''}.` : undefined} className={`mt-0.5 break-words text-[11px] font-semibold leading-4 tabular-nums ${targetMissing ? 'text-slate-400' : 'text-slate-700'}`}>{targetMissing ? '—' : formatAppraisalNumber(targetValue, metric.kind)}</p></div>
                            <div className="min-w-0 text-right"><p className="text-[10px] font-medium text-slate-500">Realisasi</p><p className="mt-0.5 break-words text-[11px] font-semibold leading-4 tabular-nums text-slate-700">{formatAppraisalNumber(actualValue, metric.kind)}</p></div>
                          </div>
                          <div className="mt-2 border-t border-slate-100 pt-1.5">
                            <div className="flex items-center justify-between gap-2"><span className="text-[10px] font-medium text-slate-500">% Realisasi</span><span className="text-xs font-bold tabular-nums text-slate-800">{formatAppraisalPercent(realizationValue)}</span></div>
                            <div aria-hidden="true" className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full transition-[width] duration-300 ${accent.progress}`} style={{ width: `${progressWidth}%` }}/></div>
                          </div>
                        </article>;
                      })}
              </div>
            </section>
          </div>

          {selectedAppraisalRm && selectedAppraisalSource && <div className="grid min-w-0 grid-cols-1 gap-3">
            <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Activity size={16} className="text-blue-700"/><h3 className="text-sm font-bold text-slate-900">Riwayat Tier</h3></div><span className="text-[10px] text-slate-500">{selectedAppraisalSource?.type || '—'}</span></div>
              {appraisalHistoryStatus === 'loading' ? <p role="status" className="mt-4 rounded-xl bg-slate-50 px-3 py-5 text-center text-xs text-slate-500"><Loader2 size={14} className="mr-2 inline animate-spin"/>Memuat maksimal empat periode {selectedAppraisalSource.type}…</p>
                : appraisalHistoryStatus === 'error' ? <div role="alert" className="mt-4 flex flex-col gap-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-xs text-rose-800 sm:flex-row sm:items-center sm:justify-between"><span>{appraisalHistoryError}</span><button disabled={appraisalRetryNotBefore > appraisalRetryClock} onClick={() => { setAppraisalHistoryStatus('idle'); setAppraisalRetryToken(token => token + 1); }} className="w-fit rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[11px] font-bold disabled:opacity-50">{appraisalRetryNotBefore > appraisalRetryClock ? `Coba lagi dalam ${Math.ceil((appraisalRetryNotBefore - appraisalRetryClock) / 1000)} dtk` : 'Coba lagi'}</button></div>
                : appraisalTierHistory.length > 0 ? <>
                <div className="mt-3 h-52 w-full min-w-0">
                  <ResponsiveContainer width="100%" height="100%"><LineChart data={appraisalTierHistory} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false}/>
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} tickMargin={7}/>
                    <YAxis type="number" dataKey="tierRank" domain={[1, 4]} ticks={[1, 2, 3, 4]} reversed width={64} tick={{ fontSize: 10 }} tickFormatter={value => `Tier ${value}`}/>
                    <Tooltip labelFormatter={label => `Periode ${label}`} formatter={(_value, _name, item) => {
                      const point = (item as { payload?: TierHistoryPoint }).payload;
                      const tooltipText = !point ? 'Tier tidak tersedia pada record ini'
                        : point.matchCount === 1 && point.tier ? `${point.tier} · Score ${point.score ?? '—'}`
                          : point.matchCount === 0 ? 'Tidak ada record PN pada periode ini'
                            : point.matchCount > 1 ? 'PN memiliki record ganda pada periode ini'
                              : 'Tier tidak tersedia pada record ini';
                      return [tooltipText, 'Hasil spreadsheet'];
                    }}/>
                    <Line type="linear" dataKey="tierRank" name="Tier dari spreadsheet" stroke="#2563eb" strokeWidth={2.5} connectNulls={false} dot={{ r: 4, fill: '#2563eb' }} activeDot={{ r: 6 }} isAnimationActive={false}/>
                  </LineChart></ResponsiveContainer>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {appraisalTierHistory.map(point => <div key={point.period} className={`rounded-lg border px-2.5 py-2 ${point.hasRecord && point.tierRank !== null ? 'border-blue-100 bg-blue-50/60' : 'border-slate-200 bg-slate-50'}`}><p className="text-[10px] font-bold text-slate-600">{point.label}</p><p className="mt-0.5 text-xs font-extrabold text-slate-800">{point.matchCount === 0 ? 'Tidak ada record' : point.matchCount > 1 ? 'Record ganda' : point.tier || 'Tier tidak tersedia'}</p>{point.hasRecord && <p className="mt-0.5 text-[10px] text-slate-500">Score {point.score ?? '—'}</p>}</div>)}
                </div>
                <p className="mt-2 text-[10px] leading-4 text-slate-500">{appraisalHistorySources.length < 4 ? `Histori belum lengkap: API hanya menyediakan ${appraisalHistorySources.length} periode ${selectedAppraisalSource.type} dalam rentang empat periode.` : `Menampilkan record PN yang cocok persis pada ${appraisalHistorySources.length} periode ${selectedAppraisalSource.type}. Bulan tanpa record menjadi gap.`} Tier 1 ditempatkan di bagian atas.</p>
              </> : <p className="mt-4 rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center text-xs leading-5 text-slate-500">Belum ada riwayat Tier yang dapat ditampilkan. Pilih periode lain untuk memuat sumber yang tersedia.</p>}
            </section>
          </div>}
        </>}
      </section>
    </div>
    <p className="rounded-xl border border-slate-200/80 bg-white/80 px-4 py-3 text-[10px] leading-relaxed text-slate-500">Sumber: snapshot Appraisal MySQL. Total score dan tier ditampilkan dari nilai sumber; UI tidak menghitung ulang aturan appraisal.</p>
  </div>
  );
};

const renderDetailUnitKerja = () => {
    const renderDelta = (value: number | null, reason = 'Nilai perubahan belum tersedia untuk periode ini.') => {
      if (value === null) return <span className="text-slate-400" title={reason}>—</span>;
      if (value === 0) return <span className="font-semibold text-slate-500">{formatFullAmount(value)}</span>;
      const positive = value > 0;
      return <span className={`inline-flex items-center justify-end gap-1 font-semibold ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>
        {formatFullAmount(value)}
        {positive ? <ArrowUpRight size={12} strokeWidth={3.25} /> : <ArrowDownRight size={12} strokeWidth={3.25} />}
      </span>;
    };

    return (
      <>
        <div className="bg-white p-3.5 rounded-2xl border border-slate-300 shadow-sm flex flex-col sm:flex-row justify-between items-center gap-4 mb-4">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-black text-slate-800 tracking-tight">Detail Kinerja Unit Kerja</h2>
          </div>
        </div>

        {renderFilterBar()}

        {(unitsWithoutCode > 0 || unitsWithoutTarget > 0) && (
          <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-[11px] font-semibold text-amber-800 flex items-center gap-2">
            <Info size={14} className="shrink-0" />
            {unitsWithoutCode} unit tanpa kode terverifikasi; {unitsWithoutTarget} unit tanpa target RKA lengkap terverifikasi. Rekap KC kosong jika seluruh unit dalam cakupan tidak memiliki nilai valid.
          </div>
        )}
        <p className="mb-3 rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-[10px] leading-relaxed text-slate-500">
          Baris KC merangkum setiap kantor sumber unik dalam cakupan sekali. Master menyediakan relasi KCP dan UNIT langsung ke KC, tetapi tidak menyediakan relasi induk KCP untuk UNIT; karena itu KCP dan UNIT ditampilkan sebagai baris turunan KC tanpa mengarang pengelompokan di antaranya.
        </p>

        <div className="min-w-0 bg-white rounded-xl border border-slate-300 shadow-sm mb-4 overflow-x-auto text-[10px]">
          <div className="min-w-0 p-3 border-b border-slate-300 flex flex-col gap-3 bg-slate-50 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex w-fit max-w-full border-2 border-black font-bold uppercase tracking-widest text-center text-[10px]">
              <div className="flex flex-col"><div className="bg-[#4f81bd] text-white px-4 sm:px-6 py-1 border-b border-black">DATA</div><div className="bg-[#dce6f1] text-black px-4 sm:px-6 py-1">VOLUME</div></div>
              <div className="w-0.5 bg-white"></div>
              <div className="flex min-w-0 flex-col border-l border-black"><div className="bg-[#4f81bd] text-white px-5 sm:px-10 py-1 border-b border-black">PRODUK</div><div className="bg-[#dce6f1] text-black px-3 sm:px-10 py-1">TABUNGAN (MIKRO)</div></div>
            </div>
            <div className="flex min-w-0 w-full items-center sm:w-auto">
               <div className="relative w-full sm:w-48">
                 <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" size={12} />
                 <input type="text" placeholder="Cari unit..." value={searchUker} onChange={(e) => setSearchUker(e.target.value)} className="box-border w-full min-w-0 pl-7 pr-3 py-1.5 bg-white border border-slate-400 outline-none rounded" />
               </div>
            </div>
          </div>

          <table className="w-full min-w-[1120px] text-black border-collapse whitespace-nowrap font-medium">
            <thead className="text-white text-center border-y-2 border-black">
              <tr className="bg-[#4f81bd] divide-x divide-white/50 border-b border-white/50">
                <th rowSpan={2} className="p-2 border-r border-white/50 w-8">NO</th>
                <th rowSpan={2} onClick={() => handleSort('uker')} className="p-2 border-r border-white/50 min-w-[200px] cursor-pointer"><span className="inline-flex items-center gap-1">Unit Kerja <ArrowUpDown size={11}/></span></th>
                <th rowSpan={2} className="p-2 border-r border-white/50 w-20">Tipe Uker</th>
                <th colSpan={2} className="p-2 border-r border-white/50">RKA VOLUME</th>
                <th colSpan={4} className="p-2 border-r border-white/50">POSISI TABUNGAN</th>
                <th colSpan={2} className="p-2 border-r border-white/50">Posisi Curr thd RKA</th>
                <th colSpan={3} className="p-2">Delta Pencapaian Curr thd</th>
              </tr>
              <tr className="bg-[#4f81bd] divide-x divide-white/50">
                <th className="p-2 font-normal">{teksBulanSaja}</th>
                <th className="p-2 font-normal">Des '26</th>
                <th className="p-2 font-normal bg-[#3b6698]">31-Dec-25</th>
                <th className="p-2 font-normal bg-[#3b6698]">{teksBulanSebelumnya}</th>
                <th className="p-2 font-normal bg-[#3b6698]">{teksD1}</th>
                <th onClick={() => handleSort('curr')} className="p-2 font-normal bg-[#3b6698] cursor-pointer"><span className="inline-flex items-center gap-1">{teksTanggal} <ArrowUpDown size={10}/></span></th>
                <th className="p-2 font-normal">Delta</th>
                <th onClick={() => handleSort('achievement')} className="p-2 font-normal cursor-pointer"><span className="inline-flex items-center gap-1">% <ArrowUpDown size={10}/></span></th>
                <th onClick={() => handleSort('ytd_diff')} className="p-2 font-normal bg-[#3b6698] cursor-pointer"><span className="inline-flex items-center gap-1">YTD <ArrowUpDown size={10}/></span></th>
                <th onClick={() => handleSort('mtd_diff')} className="p-2 font-normal bg-[#3b6698] cursor-pointer"><span className="inline-flex items-center gap-1">MTD <ArrowUpDown size={10}/></span></th>
                <th onClick={() => handleSort('dtd_diff')} className="p-2 font-normal bg-[#3b6698] cursor-pointer"><span className="inline-flex items-center gap-1">DTD <ArrowUpDown size={10}/></span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-300">
              {groupedDetailData.map(({ name: cabangName, kcCode, units: groupedUnits }, cIdx) => {
                const { totals, complete } = detailGroupTotals(groupedUnits);
                const ukers = detailChildrenForGroup({ name: cabangName, kcCode, units: groupedUnits });
                const kcPercentage = complete.rka && complete.curr && totals.rka > 0 ? totals.curr / totals.rka * 100 : null;
                return (
                  <React.Fragment key={cIdx}>
                    <tr className="bg-[#b8cce4] font-bold divide-x divide-slate-400 border-y-2 border-black" title={kcCode ? 'Rekap setiap unit sumber di bawah KC ini, masing-masing dihitung satu kali setelah baris konsolidasi dikecualikan.' : 'Rekap kantor; relasi KC pada master belum terverifikasi.'}>
          <td className="p-1.5 text-center">{cIdx + 1}</td>
                      <td className="p-1.5 text-left">{cabangName}</td>
                      <td className="p-1.5 text-center">{kcCode ? 'KC' : '—'}</td>
                      <td className="p-1.5 text-right">{complete.rka ? formatFullAmount(totals.rka) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.rkaDec ? formatFullAmount(totals.rkaDec) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.des25 ? formatFullAmount(totals.des25) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.prev ? formatFullAmount(totals.prev) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.d1 ? formatFullAmount(totals.d1) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.curr ? formatFullAmount(totals.curr) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.rka && complete.curr ? renderDelta(totals.curr - totals.rka) : '—'}</td>
                      <td className={`p-1.5 text-right ${getAchievementCellClass(getAchievementTone(kcPercentage))}`}>
                        {kcPercentage === null ? '—' : <span className={`font-bold ${getAchievementTextClass(getAchievementTone(kcPercentage))}`}>{kcPercentage.toFixed(2)}%</span>}
                      </td>
                      <td className="p-1.5 text-right">{complete.curr && complete.des25 ? renderDelta(totals.curr - totals.des25) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.curr && complete.prev ? renderDelta(totals.curr - totals.prev) : '—'}</td>
                      <td className="p-1.5 text-right">{complete.curr && complete.d1 ? renderDelta(totals.curr - totals.d1) : '—'}</td>
                    </tr>
                    {ukers.map((u: any, i: number) => {
                      const rkaDetail = detailRkaByUnit.get(u) || {
                        unitType: u.unitType || 'KCP', monthly: null, monthlyStatus: 'Tidak ada baris sumber untuk kantor ini.',
                        december: null, decemberStatus: 'Tidak ada baris sumber untuk kantor ini.'
                      };
                      const rkaUker = rkaDetail.monthly;
                      const rkaUkerDec = rkaDetail.december;
                      const deltaRka = rkaUker === null || !u.has_curr ? null : u.curr - rkaUker;
                      const pctRka = rkaUker !== null && rkaUker > 0 && u.has_curr ? (u.curr / rkaUker) * 100 : null;
                      const rowPositionAvailable = u.has_curr === true;
                      const rowHasPrev = u.has_prev === true;
                      const rowHasDes25 = u.has_des25 === true;
                      const rowHasD1 = u.has_d_min_1 === true;
                      return (
                        <tr key={u.kode_uker || `${u.uker}-${i}`} onClick={() => !u.synthetic && setSelectedUkerModal(u)} className={`divide-x divide-slate-300 ${u.synthetic ? 'bg-slate-50 text-slate-400' : 'hover:bg-slate-100 cursor-pointer'}`}>
                          <td className="p-1.5 text-center">{cIdx + 1}.{i + 1}</td>
                          <td className="p-1.5 text-left font-bold text-[#004a8c]" title={rkaDetail.monthlyStatus || undefined}>
                            <span className={rkaDetail.unitType === 'KC' ? '' : 'pl-4'}>{u.uker}</span>
                            {rkaUker === null && !u.synthetic && <span className="ml-1 text-amber-600" aria-label="Target tidak terverifikasi">⚠</span>}
                          </td>
                          <td className="p-1.5 text-center">{rkaDetail.unitType}</td>
                          <td className="p-1.5 text-right" title={rkaUker === null ? rkaDetail.monthlyStatus || undefined : `Rp ${formatExactAmount(rkaUker)}`}>{rkaUker === null ? '—' : formatFullAmount(rkaUker)}</td>
                          <td className="p-1.5 text-right" title={rkaUkerDec === null ? rkaDetail.decemberStatus || undefined : `Rp ${formatExactAmount(rkaUkerDec)}`}>{rkaUkerDec === null ? '—' : formatFullAmount(rkaUkerDec)}</td>
                          <td className="p-1.5 text-right" title={!rowHasDes25 ? 'Snapshot posisi 31 Desember 2025 tidak tersedia untuk unit ini.' : `Rp ${formatExactAmount(u.des25)}`}>{rowHasDes25 ? formatFullAmount(u.des25) : '—'}</td>
                          <td className="p-1.5 text-right" title={!rowHasPrev ? 'Snapshot akhir bulan sebelumnya tidak tersedia untuk unit ini.' : `Rp ${formatExactAmount(u.prev)}`}>{rowHasPrev ? formatFullAmount(u.prev) : '—'}</td>
                          <td className="p-1.5 text-right" title={!rowHasD1 ? 'Snapshot hari sebelumnya tidak tersedia untuk unit ini.' : `Rp ${formatExactAmount(u.d_min_1)}`}>{rowHasD1 ? formatFullAmount(u.d_min_1) : '—'}</td>
                          <td className="p-1.5 text-right bg-slate-50 font-bold" title={!rowPositionAvailable ? 'Snapshot posisi pada periode terpilih tidak tersedia untuk unit ini.' : `Rp ${formatExactAmount(u.curr)}`}>{rowPositionAvailable ? formatFullAmount(u.curr) : '—'}</td>
                          <td className="p-1.5 text-right" title={deltaRka === null ? rkaDetail.monthlyStatus || 'Posisi aktual belum tersedia.' : undefined}>
                            {renderDelta(deltaRka)}
                          </td>
                          <td className={`p-1.5 text-right font-bold ${getAchievementCellClass(getAchievementTone(pctRka))}`} title={pctRka === null ? rkaUker === null ? rkaDetail.monthlyStatus || undefined : rkaUker === 0 ? 'Target RKA bernilai 0 sehingga persentase tidak dapat dihitung.' : 'Posisi aktual belum tersedia.' : undefined}>
                            {pctRka === null ? '—' : <span className={`font-bold ${getAchievementTextClass(getAchievementTone(pctRka))}`}>{pctRka.toFixed(2)}%</span>}
                          </td>
                          <td className="p-1.5 text-right">{renderDelta(u.ytd_diff, !rowPositionAvailable ? 'Posisi periode terpilih tidak tersedia.' : 'Snapshot 31 Desember 2025 tidak tersedia.')}</td>
                          <td className="p-1.5 text-right">{renderDelta(u.mtd_diff, !rowPositionAvailable ? 'Posisi periode terpilih tidak tersedia.' : 'Snapshot akhir bulan sebelumnya tidak tersedia.')}</td>
                          <td className="p-1.5 text-right">{renderDelta(u.dtd_diff, !rowPositionAvailable ? 'Posisi periode terpilih tidak tersedia.' : 'Snapshot hari sebelumnya tidak tersedia.')}</td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </>
    )
  }

  const CustomizedDotLabel = (props: any) => {
    const { x, y, value, stroke } = props;
    if (value === null || value === undefined || isNaN(value) || value === 0) return null;
    return (
      <text 
        x={x} 
        y={y - 12} 
        fill={stroke} 
        textAnchor="middle" 
        fontSize={9} 
        fontWeight={800}
      >
        {formatUangDetail(value)}
      </text>
    );
  };

  const renderSummaryChart = (data: any[], primaryColor: string) => (
    <div className="relative mt-1 h-40 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 20, right: 20, left: 20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis 
            dataKey="name" 
            interval={0} 
            padding={{ left: 20, right: 20 }} 
            axisLine={false} 
            tickLine={false} 
            tick={{ fontSize: 9, fill: '#64748b', fontWeight: 700 }} 
            tickMargin={8} 
          />
          <YAxis hide={true} domain={['dataMin * 0.95', 'dataMax * 1.1']} />
          <Tooltip content={<CustomSummaryTooltip />} cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '3 3' }}/>
          <Line 
            type="monotone" 
            dataKey="value" 
            stroke={primaryColor} 
            strokeWidth={3} 
            dot={{ r: 5, strokeWidth: 2, fill: '#fff', stroke: primaryColor }} 
            activeDot={{ r: 7 }} 
            label={<CustomizedDotLabel stroke={primaryColor} />}
            isAnimationActive={false} 
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );

  const renderChart = (dataKeyName: string, data: any[], primaryColor: string) => (
    <div className="relative mt-2 h-48 w-full min-w-0 sm:h-56">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
          <defs>
            <linearGradient id={`gradCurr-${dataKeyName}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={primaryColor} stopOpacity={0.3}/>
              <stop offset="95%" stopColor={primaryColor} stopOpacity={0.0}/>
            </linearGradient>
            <linearGradient id={`gradPrev-${dataKeyName}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#94a3b8" stopOpacity={0.2}/>
              <stop offset="95%" stopColor="#94a3b8" stopOpacity={0.0}/>
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
          <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }} tickMargin={8} />
          <YAxis domain={['auto', 'auto']} axisLine={false} tickLine={false} width={40} tick={{ fontSize: 9, fill: '#94a3b8', fontWeight: 600 }} tickFormatter={(val) => formatUangDetail(val)} />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '3 3' }}/>
          <Legend onClick={handleLegendClick} verticalAlign="bottom" height={24} iconType="circle" wrapperStyle={{ fontSize: '9px', color: '#64748b', paddingTop: '4px', fontWeight: 600, cursor: 'pointer' }}/>
          
          <Area hide={!visibleLines.dec25} type="monotone" dataKey="dec25" name="Des '25" stroke="#cbd5e1" strokeWidth={2} fill="transparent" dot={false} strokeDasharray="3 3" isAnimationActive={false} />
          <Area hide={!visibleLines.jun26} type="monotone" dataKey="jun26" name="Jun '26" stroke="#94a3b8" strokeWidth={2} fill="transparent" dot={false} isAnimationActive={false} />
          <Area hide={!visibleLines.jul26} type="monotone" dataKey="jul26" name="Jul '26" stroke="#64748b" strokeWidth={3} fill="transparent" dot={false} isAnimationActive={false} />
          <Area hide={!visibleLines.aug26} type="monotone" dataKey="aug26" name="Agu '26" stroke="#475569" strokeWidth={3} fill="transparent" dot={false} isAnimationActive={false} />
          <Area hide={!visibleLines.sep26} type="monotone" dataKey="sep26" name="Sep '26" stroke="#94a3b8" fill={`url(#gradPrev-${dataKeyName})`} strokeWidth={3} dot={{ r: 0 }} activeDot={{ r: 6 }} isAnimationActive={false} />
          <Area hide={!visibleLines.oct26} type="monotone" dataKey="oct26" name="Okt '26" stroke={primaryColor} fill={`url(#gradCurr-${dataKeyName})`} strokeWidth={4} dot={{ r: 0 }} activeDot={{ r: 6 }} connectNulls={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );

  let modalRkaResult: { value: number | null; reason: string | null } = { value: null, reason: 'Pilih unit untuk melihat status target RKA.' };
  let modalPosition: number | null = null;
  if (selectedUkerModal) {
    const kodeUkerM = findKodeUker(selectedUkerModal.uker, selectedUkerModal.kode_uker);
    modalRkaResult = getRkaTargetResult(kodeUkerM, 'A Tabungan Retail Funding');
    const modalSnapshotDay = engineData.stats.tabungan.snapshotDay;
    const modalTabByDay: Record<number, number> = selectedUkerModal.posByDay?.tabungan || {};
    if (modalSnapshotDay !== null && modalSnapshotDay !== undefined && Object.prototype.hasOwnProperty.call(modalTabByDay, modalSnapshotDay)) {
      modalPosition = modalTabByDay[modalSnapshotDay];
    }
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[#f4f7fb] font-sans text-slate-800">
      
      {selectedUkerModal && (
        <div className="fixed inset-0 z-[999] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden border border-white my-auto animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 py-4 border-b border-slate-200 flex justify-between items-center bg-white">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#004a8c] flex items-center justify-center text-white">
                  <Building2 size={20} strokeWidth={2}/>
                </div>
                <div>
                  <h2 className="text-lg font-black text-slate-800">{selectedUkerModal.uker}</h2>
                  <p className="text-[10px] text-slate-400 tracking-widest mt-0.5 uppercase font-bold">{selectedUkerModal.cabang}</p>
                </div>
              </div>
              <button onClick={() => setSelectedUkerModal(null)} className="p-2 bg-slate-100 hover:bg-rose-50 hover:text-rose-500 rounded-lg text-slate-500 transition-colors">
                <X size={18} strokeWidth={2.5}/>
              </button>
            </div>
            
          <div className="p-3 sm:p-6 grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6 bg-slate-50/50 overflow-y-auto max-h-[calc(100dvh-7rem)]">
              <StatCardV2 
                title="KINERJA TABUNGAN MIKRO" icon={Wallet} 
                themeCode="#004a8c" textCode="#004a8c" 
                dataVal={modalPosition} comparisonPosition={modalPosition} rkaVal={modalRkaResult.value} rkaComplete={modalPosition !== null && modalRkaResult.value !== null} rkaComparedUnits={modalPosition !== null && modalRkaResult.value !== null ? 1 : 0} rkaTotalUnits={1} rkaStatus={modalRkaResult.reason || (modalPosition === null ? 'Posisi Tabungan unit tidak tersedia pada snapshot kategori terpilih.' : null)} progVal={null} progStatus={prognosisStatus} isAverageMode={false} 
                dtd={selectedUkerModal.dtd_diff} mtd={selectedUkerModal.mtd_diff} mtm={null} ytd={selectedUkerModal.ytd_diff}
              />
              <div className="bg-white p-5 rounded-2xl border border-slate-200/90 shadow-sm flex flex-col">
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-800 mb-2 border-b border-slate-100 pb-2 text-center">Trend Posisi Uker</h3>
                <div className="flex-1 w-full min-h-[220px]">
                  {modalChartData && renderChart('modal', modalChartData, '#004a8c')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isMobileMenuOpen && <button type="button" aria-label="Tutup menu navigasi" onClick={() => setIsMobileMenuOpen(false)} className="fixed inset-0 z-40 bg-slate-950/30 lg:hidden" />}
      <div className={`fixed lg:relative inset-y-3 left-3 z-50 flex flex-col h-[calc(100dvh-1.5rem)] bg-[#0b2347] border border-[#17385f] rounded-[1.35rem] transition-all duration-300 shadow-[0_18px_44px_-18px_rgba(8,28,58,0.48)] ${isMobileMenuOpen ? 'translate-x-0 w-64' : '-translate-x-[120%] lg:translate-x-0'} ${isSidebarOpen ? 'lg:w-64' : 'lg:w-[5.25rem]'}`}>
        <div className="w-full flex flex-col h-full overflow-hidden">
          <div className="p-4 flex items-center justify-between border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#1689e8] to-[#1760a8] flex items-center justify-center text-white shadow-md shadow-black/20 ring-1 ring-white/15">
                <Landmark size={20} strokeWidth={2.5} />
              </div>
              {isSidebarOpen && (
                <div>
                  <h1 className="text-white text-[12px] font-extrabold tracking-[0.025em]">DASHBOARD FUNDING</h1>
                  <p className="mt-1 max-w-[158px] text-[8px] font-medium leading-[1.35] text-blue-100/70">Monitoring Kinerja dan Pencapaian RMFT</p>
                </div>
              )}
            </div>
              <button type="button" onClick={() => setIsSidebarOpen(open => !open)} aria-label={isSidebarOpen ? 'Ciutkan sidebar' : 'Perluas sidebar'} className="p-1.5 rounded-lg text-blue-100/70 hover:bg-white/10 hover:text-white transition-colors">
              <ChevronLeft size={16} className={isSidebarOpen ? '' : 'rotate-180'} />
            </button>
          </div>
          
          <div className="flex-1 py-4 px-2.5 space-y-1.5 overflow-y-auto">
            {MENU_ITEMS.map((item) => {
              const active = activeMenu === item.name;
              return (
                <button key={item.name} onClick={() => { setActiveMenu(item.name); setIsMobileMenuOpen(false); }} className={`w-full flex items-center px-3.5 py-3 rounded-xl text-xs transition-all cursor-pointer font-semibold ${active ? 'bg-blue-400/15 text-white shadow-[inset_3px_0_0_#38bdf8]' : 'text-blue-100/75 hover:bg-white/[0.06] hover:text-white'}`}>
                  <item.icon size={18} strokeWidth={active ? 2.5 : 2} className={active ? 'text-sky-300' : 'text-blue-200/60'} />
                  {isSidebarOpen && <span className="ml-3">{item.name}</span>}
                </button>
              );
            })}
          </div>

          {isSidebarOpen && (
            <div className="p-3 m-2 rounded-2xl bg-white/[0.06] border border-white/10">
              <button type="button" onClick={() => setShowProfile(open => !open)} aria-expanded={showProfile} className="w-full flex items-center gap-3 mb-3 text-left">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-sky-500 to-blue-700 text-white flex items-center justify-center font-bold text-xs ring-1 ring-white/20">
                  {profileName.substring(0,2).toUpperCase()}
                </div>
                <div className="overflow-hidden">
                  <div className="font-bold text-white truncate text-[11px]">{profileName}</div>
                  <div className="text-[9px] text-blue-100/60 uppercase tracking-widest truncate">{profileRole}</div>
                </div>
              </button>
              {showProfile && <div className="mb-3 text-[9px] text-blue-100/70">Unit: {profileCabang}</div>}
              <button onClick={handleLogout} className="w-full text-center text-[10px] font-bold text-rose-200 hover:text-white border border-rose-300/20 bg-rose-400/10 hover:bg-rose-400/20 py-1.5 rounded-lg cursor-pointer transition-colors flex items-center justify-center gap-1.5"><LogOut size={12}/>Log Out</button>
            </div>
          )}
        </div>
      </div>
      
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative">
        <div className="min-h-[4.25rem] flex shrink-0 items-center gap-1.5 border-b border-slate-200/80 bg-white/85 px-3 py-2 backdrop-blur-sm sm:gap-2 sm:px-7">
          <button onClick={() => setIsMobileMenuOpen(true)} aria-label="Buka menu navigasi" className="lg:hidden shrink-0 p-2 bg-white rounded-lg border border-slate-200 mr-1 sm:mr-2 text-slate-600 cursor-pointer shadow-sm"><Menu size={18}/></button>
          <div className="min-w-0 flex-1"><span className="block text-[9px] sm:text-[10px] font-extrabold uppercase tracking-[0.12em] sm:tracking-[0.14em] text-blue-700">DASHBOARD FUNDING</span><span className="mt-0.5 block truncate text-[8px] sm:text-[9px] leading-3 text-slate-500">Monitoring Kinerja dan Pencapaian RMFT</span><span className="mt-0.5 block truncate text-xs sm:text-sm font-semibold text-slate-800">{activeMenu}</span></div>
        </div>

        <div className="dashboard-canvas flex-1 min-w-0 overflow-y-auto p-3 sm:p-5 lg:p-7 pb-20 lg:pb-7 scrollbar-hide">
          {activeMenu === 'Dashboard Posisi Dana' && renderDashboardPosisi()}
          {activeMenu === 'Dashboard Marginal' && renderDashboardMarginal()}
          {activeMenu === 'Detail Unit Kerja' && renderDetailUnitKerja()}
          {activeMenu === 'Appraisal' && renderDashboardAppraisal()}
        </div>
      </div>
    </div>
  );
};

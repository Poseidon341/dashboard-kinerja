import React, { useEffect, useState } from 'react';
import { FileSpreadsheet, LockKeyhole, RefreshCw, UploadCloud } from 'lucide-react';

type ReportType = { key: string; label: string; available: boolean; template?: string; reason?: string };
type PreviewDate = { rows: number; validRows: number; invalidRows: number; officeLabels: number;
  segments: number; products: number; identicalSource: boolean;
  existing: null | { rows: number; source: string; checksum?: string; version?: number; batchId?: string } };
type Preview = { previewId: string; filename: string; checksum: string; totalRows: number; validRows: number;
  invalidRows: number; validationErrors: Record<string, number>; headers: string[];
  previewRows: Array<Record<string, unknown>>; dates: Record<string, PreviewDate> };
type Job = { status: string; phase: string; processed: number; total: number; dates: string[];
  error?: string | null; result?: { publishedDates: string[]; alreadyPublishedDates?: string[] } | null };

const defaultTypes: ReportType[] = [
  { key: 'position', label: 'Posisi Dana / segmen_data', available: true },
  { key: 'rka', label: 'RKA', available: false },
  { key: 'prognosis', label: 'Prognosa', available: false },
  { key: 'master', label: 'RMFT / Master Unit Kerja', available: false },
  { key: 'appraisal', label: 'Appraisal', available: false },
];

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
  return payload as T;
}

export function AdminUpdateData({ onPublished }: { onPublished: () => void }) {
  const [auth, setAuth] = useState<{ user: string; csrf: string } | null>(null);
  const [authError, setAuthError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [types, setTypes] = useState<ReportType[]>(defaultTypes);
  const [type, setType] = useState('position');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, 'add' | 'replace' | 'cancel'>>({});
  const [confirmation, setConfirmation] = useState('');
  const [snapshotComplete, setSnapshotComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);

  useEffect(() => {
    let active = true;
    api<{ status: string; user: string; csrf: string; reportTypes: ReportType[] }>('/api/admin/session')
      .then(data => { if (active) { setAuth({ user: data.user, csrf: data.csrf }); setTypes(data.reportTypes); } })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!auth) return;
    api<{ records: Array<Record<string, unknown>> }>('/api/admin/history')
      .then(data => setHistory(data.records)).catch(() => {});
  }, [auth, job?.status]);

  useEffect(() => {
    if (!jobId || !auth || job?.status === 'completed' || job?.status === 'failed') return;
    let active = true;
    const timer = setInterval(() => {
      api<Job>(`/api/admin/jobs/${encodeURIComponent(jobId)}`)
        .then(data => {
          if (!active) return;
          setJob(data);
          if (data.status === 'completed') onPublished();
        })
        .catch(message => { if (active) setError(String(message)); });
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [jobId, auth, job?.status, onPublished]);

  const selected = types.find(item => item.key === type);
  const hasReplacement = Object.values(decisions).includes('replace');
  const selectedCount = Object.values(decisions).filter(value => value !== 'cancel').length;
  const canCommit = !!auth && !!preview && preview.invalidRows === 0
    && Object.keys(preview.validationErrors).length === 0 && selectedCount > 0
    && snapshotComplete && (!hasReplacement || confirmation === 'GANTI SNAPSHOT TANGGAL') && !busy && !jobId;

  async function login(event: React.FormEvent) {
    event.preventDefault(); setAuthError('');
    try {
      const data = await api<{ user: string; csrf: string }>('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      setAuth({ user: data.user, csrf: data.csrf }); setPassword('');
    } catch (cause) { setAuthError(cause instanceof Error ? cause.message : 'Login Admin gagal.'); }
  }

  async function upload() {
    if (!file || !auth || !selected?.available) return;
    setBusy(true); setError(''); setPreview(null); setJob(null); setJobId('');
    try {
      const data = await api<Preview>(`/api/admin/preview?type=${encodeURIComponent(type)}`, {
        method: 'POST', headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'X-Admin-CSRF': auth.csrf, 'X-Admin-Filename': encodeURIComponent(file.name),
        }, body: file,
      });
      setPreview(data);
      setDecisions(Object.fromEntries(Object.entries(data.dates).map(([date, item]) =>
        [date, item.existing ? 'cancel' : 'add'])));
      setConfirmation('');
      setSnapshotComplete(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Validasi upload gagal.'); }
    finally { setBusy(false); }
  }

  async function commit() {
    if (!preview || !auth || !canCommit) return;
    setBusy(true); setError('');
    try {
      const data = await api<{ jobId: string }>('/api/admin/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-CSRF': auth.csrf },
        body: JSON.stringify({ previewId: preview.previewId, decisions, confirmation, snapshotComplete }),
      });
      setJobId(data.jobId); setJob({ status: 'processing', phase: 'queued', processed: 0,
        total: preview.totalRows, dates: Object.keys(decisions).filter(date => decisions[date] !== 'cancel') });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Penyimpanan gagal.'); }
    finally { setBusy(false); }
  }

  if (!auth) return <section className="mx-auto max-w-xl space-y-4">
    <div className="rounded-2xl border border-blue-100 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-3"><LockKeyhole className="text-blue-700" size={22} />
        <div><h2 className="font-bold text-slate-900">Admin · Update Data</h2>
          <p className="text-xs text-slate-500">Masuk dengan kredensial Admin khusus untuk mengunggah data.</p></div></div>
      <form onSubmit={login} className="space-y-3">
        <label className="block text-xs font-semibold text-slate-600">Pengguna Admin<input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm" /></label>
        <label className="block text-xs font-semibold text-slate-600">Kata sandi<input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm" /></label>
        {authError && <p role="alert" className="text-xs text-rose-700">{authError}</p>}
        <button className="w-full rounded-xl bg-blue-700 px-4 py-3 text-sm font-bold text-white">Masuk Admin</button>
      </form>
    </div>
  </section>;

  return <section className="mx-auto max-w-5xl space-y-4 pb-8">
    <div className="rounded-2xl bg-[#0b2347] p-5 text-white shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-widest text-sky-200">Admin · Update Data</p>
      <h2 className="mt-1 text-xl font-extrabold">Upload laporan Excel</h2>
      <p className="mt-2 text-xs text-blue-100/80">Validasi setiap tanggal posisi sebelum menyimpan. Snapshot lama tetap tersedia sebagai versi sebelumnya.</p>
      <p className="mt-2 text-[11px] text-blue-100/70">Masuk sebagai {auth.user}</p>
      <button type="button" onClick={async () => {
        try { await api('/api/admin/logout', { method: 'POST' }); } catch { /* Logout lokal tetap dijalankan. */ } finally {
          setAuth(null); setPreview(null); setJobId(''); setJob(null); setHistory([]);
        }
      }} className="mt-3 rounded-lg border border-blue-300/40 px-3 py-2 text-xs font-semibold text-blue-100">Keluar Admin</button>
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <label className="block text-xs font-bold text-slate-700">Jenis laporan
          <select value={type} onChange={event => { setType(event.target.value); setPreview(null); setFile(null); }} className="mt-2 w-full rounded-xl border border-slate-300 bg-white p-3 text-sm">
            {types.map(item => <option key={item.key} value={item.key}>{item.label}{item.available ? '' : ' · Belum Tersedia'}</option>)}
          </select>
        </label>
        {selected?.available ? <>
          <p className="mt-3 text-[11px] text-slate-500">Template: {selected.template}</p>
          <label className="mt-4 block text-xs font-bold text-slate-700">File .xlsx
            <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} className="mt-2 block w-full min-w-0 rounded-xl border border-dashed border-blue-200 bg-blue-50 p-3 text-xs" />
          </label>
          <button type="button" disabled={!file || busy || !!jobId} onClick={upload} className="mt-4 inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"><UploadCloud size={16} />{busy ? 'Memvalidasi workbook…' : 'Upload & preview'}</button>
        </> : <p className="mt-4 rounded-xl bg-amber-50 p-3 text-xs text-amber-800">Belum Tersedia. {selected?.reason || 'Aturan publikasi belum disahkan.'}</p>}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><FileSpreadsheet size={17} /> Status validasi</h3>
        {preview ? <div className="mt-4 space-y-2 text-xs text-slate-700">
          <p className="break-all font-semibold">{preview.filename}</p>
          <p>Baris: {preview.totalRows.toLocaleString('id-ID')} · Valid: {preview.validRows.toLocaleString('id-ID')} · Tidak valid: {preview.invalidRows.toLocaleString('id-ID')}</p>
          <p className="break-all text-[10px] text-slate-500">SHA-256: {preview.checksum}</p>
          {Object.keys(preview.validationErrors).length > 0 && <p role="alert" className="text-rose-700">Kesalahan: {Object.entries(preview.validationErrors).map(([key, value]) => `${key} (${value})`).join(', ')}</p>}
        </div> : <p className="mt-4 text-xs text-slate-500">Belum ada file yang divalidasi.</p>}
        {job && <div className="mt-4 rounded-xl bg-blue-50 p-3 text-xs text-blue-900">
          <p className="font-bold">{job.status === 'completed' ? (job.result?.publishedDates.length ? 'Data selesai dipublikasikan' : 'Snapshot identik sudah tersedia') : job.status === 'failed' ? 'Penyimpanan gagal' : 'Sedang diproses'}</p>
          {job.result?.publishedDates.length ? <p>Tanggal terbit: {job.result.publishedDates.join(', ')}</p> : null}
          <p>{job.phase} · {job.processed.toLocaleString('id-ID')} / {job.total.toLocaleString('id-ID')} baris</p>
          {job.error && <p className="mt-1 text-rose-700">{job.error}</p>}
        </div>}
      </div>
    </div>
    {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs text-rose-700">{error}</p>}
    {preview && <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-bold text-slate-800">Tanggal posisi dari kolom Posisi</h3>
      <p className="mt-1 text-xs text-slate-500">Tanggal yang sudah ada dilewati secara default. Penggantian hanya berlaku untuk tanggal terpilih; tanggal lain tetap aktif. Periksa kelengkapan cakupan sumber sebelum menyimpan.</p>
      <div className="mt-4 space-y-2">{Object.entries(preview.dates).map(([date, item]) => <div key={date} className="grid gap-2 rounded-xl border border-slate-200 p-3 text-xs sm:grid-cols-[1fr_auto] sm:items-center">
        <div><span className="font-bold text-slate-800">{date}</span> · bulan {date.slice(0, 7)} · {item.rows.toLocaleString('id-ID')} baris
          <p className="mt-1 text-slate-500">Valid {item.validRows.toLocaleString('id-ID')} / tidak valid {item.invalidRows.toLocaleString('id-ID')} · {item.officeLabels} label kantor · {item.segments} segmen · {item.products} produk</p>
          <p className="mt-1 text-slate-500">{item.identicalSource ? 'Snapshot dari file identik sudah aktif' : item.existing ? `Sudah ada: ${item.existing.rows.toLocaleString('id-ID')} baris` : 'Tanggal baru'}</p></div>
        <select aria-label={`Tindakan tanggal ${date}`} value={decisions[date] ?? 'cancel'} onChange={event => setDecisions(current => ({ ...current, [date]: event.target.value as 'add' | 'replace' | 'cancel' }))} className="rounded-lg border border-slate-300 bg-white p-2">
          <option value="cancel">Lewati tanggal ini</option><option value={item.existing ? 'replace' : 'add'}>{item.existing ? 'Ganti Snapshot Tanggal' : 'Tambah snapshot tanggal'}</option>
        </select>
      </div>)}</div>
      <label className="mt-4 flex items-start gap-2 text-xs font-semibold text-slate-700"><input type="checkbox" checked={snapshotComplete} onChange={event => setSnapshotComplete(event.target.checked)} className="mt-0.5" />Saya telah memastikan setiap tanggal terpilih memuat snapshot lengkap untuk cakupan sumbernya. File parsial tidak boleh dipublikasikan sebagai pengganti snapshot tanggal.</label>
      {hasReplacement && <label className="mt-4 block text-xs font-semibold text-amber-800">Ketik GANTI SNAPSHOT TANGGAL untuk mengonfirmasi penggantian
        <input value={confirmation} onChange={event => setConfirmation(event.target.value)} className="mt-1 w-full rounded-xl border border-amber-300 p-3 text-sm" />
      </label>}
      <button type="button" disabled={!canCommit} onClick={commit} className="mt-4 rounded-xl bg-emerald-700 px-5 py-3 text-xs font-bold text-white disabled:opacity-50">Konfirmasi & simpan ke MySQL</button>
      <div className="mt-5 overflow-x-auto"><table className="min-w-[650px] w-full text-left text-[11px]">
        <thead><tr className="border-b border-slate-200 text-slate-500"><th className="p-2">Baris</th><th className="p-2">Tanggal</th><th className="p-2">Segmen</th><th className="p-2">Produk</th><th className="p-2">Unit sumber</th><th className="p-2">Status</th></tr></thead>
        <tbody>{preview.previewRows.map((row, index) => <tr key={index} className="border-b border-slate-100"><td className="p-2">{String(row.sourceRowNumber ?? '')}</td><td className="p-2">{String(row.positionDate ?? '—')}</td><td className="p-2">{String(row.segment ?? '—')}</td><td className="p-2">{String(row.product ?? '—')}</td><td className="p-2">{String(row.office ?? '—')}</td><td className="p-2">{row.valid ? 'Valid' : String(row.errors ?? 'Invalid')}</td></tr>)}</tbody>
      </table></div>
    </div>}
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><RefreshCw size={16} /> Riwayat upload</h3>
      {history.length ? <div className="mt-3 overflow-x-auto"><table className="min-w-[600px] w-full text-left text-xs"><thead><tr className="border-b border-slate-200 text-slate-500"><th className="p-2">Waktu</th><th className="p-2">Pengguna</th><th className="p-2">Laporan</th><th className="p-2">Tanggal / periode lama</th><th className="p-2">Status</th></tr></thead><tbody>{history.map((item, index) => <tr key={index} className="border-b border-slate-100"><td className="p-2">{String(item.at ?? '')}</td><td className="p-2">{String(item.user ?? '—')}</td><td className="p-2">Posisi Dana</td><td className="p-2">{String(item.period ?? '')}</td><td className="p-2">{String(item.status ?? '')}</td></tr>)}</tbody></table></div>
        : <p className="mt-3 text-xs text-slate-500">Belum ada publikasi melalui menu Admin.</p>}
    </div>
  </section>;
}

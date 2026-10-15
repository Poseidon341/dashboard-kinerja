import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDetailOfficePlaceholder,
  getSourceOfficeType,
  getOfficeKcCode,
  matchesDetailSourceScope,
  matchesDetailOfficeScope,
  matchesSelectedOfficeType,
  normalizeOfficeType,
} from '../src/detailUnitFilter.mjs';

const kc = { 'BRANCH CODE': '001', 'BRANCH TYPE': ' KC ', BRANCH: 'KC BANYUWANGI' };
const kcp = { 'BRANCH CODE': '002', 'BRANCH TYPE': 'kcp', 'MAIN BRANCH CODE': '001', BRANCH: 'MUNCAR' };
const kk = { 'BRANCH CODE': '003', 'BRANCH TYPE': 'KK', 'MAIN BRANCH CODE': '001', BRANCH: 'PASAR' };
const unit = { 'BRANCH CODE': '004', 'BRANCH TYPE': 'UNIT', 'MAIN BRANCH CODE': '001', BRANCH: 'MUNCAR UNIT' };

test('tipe sumber dengan awalan terikat mengambil prioritas atas BRANCH TYPE master yang bertentangan', () => {
  assert.equal(normalizeOfficeType(' kcp '), 'KCP');
  assert.equal(matchesSelectedOfficeType(kc, 'KC'), true);
  assert.equal(matchesSelectedOfficeType(kcp, 'KCP'), true);
  assert.equal(matchesSelectedOfficeType(kk, 'KK'), true);
  assert.equal(matchesSelectedOfficeType(unit, 'UNIT'), true);
  assert.equal(getSourceOfficeType('KK YAYASAN PUSPA DUNIA'), 'KK');
  assert.equal(matchesSelectedOfficeType(kc, 'KK', 'KK YAYASAN PUSPA DUNIA'), true);
  assert.equal(matchesSelectedOfficeType(kc, 'KC', 'KK YAYASAN PUSPA DUNIA'), false);
  assert.equal(matchesSelectedOfficeType({ ...unit, BRANCH: 'Nama tanpa kata UNIT' }, 'UNIT'), true);
  assert.equal(matchesSelectedOfficeType(kc, 'KCP'), false);
  assert.equal(matchesSelectedOfficeType(null, 'KC'), false);
  assert.equal(matchesSelectedOfficeType(null, 'ALL'), true);
  assert.equal(getSourceOfficeType('KANTOR KCP MALANG'), null);
  assert.equal(getSourceOfficeType('UNITARIAN'), null);
});
test('Semua Tipe memuat semua kantor; opsi bertipe membatasi hasil ke nilai master yang dipilih', () => {
  const offices = [kc, kcp, kk, unit];
  assert.deepEqual(offices.filter(office => matchesSelectedOfficeType(office, 'ALL')), offices);
  for (const type of ['KC', 'KCP', 'KK', 'UNIT']) {
    const filtered = offices.filter(office => matchesSelectedOfficeType(office, type));
    assert.equal(filtered.length, 1);
    assert.equal(normalizeOfficeType(filtered[0]['BRANCH TYPE']), type);
  }
  assert.equal(offices.filter(office => matchesSelectedOfficeType(office, ' kk ')).length, 1);
});

test('parent grouping uses only KC self-code or source MAIN BRANCH CODE; it never infers UNIT-to-KCP', () => {
  assert.equal(getOfficeKcCode(kc), '001');
  assert.equal(getOfficeKcCode(kcp), '001');
  assert.equal(getOfficeKcCode(unit), '001');
  assert.equal(getOfficeKcCode({ ...unit, 'MAIN BRANCH CODE': '' }), null);
});

test('Area and cabang scope match master rows by their KC parent', () => {
  const areas = { 'Area Jember': ['Banyuwangi', 'Genteng'] };
  assert.equal(matchesDetailOfficeScope(kcp, kc, 'Area Jember', 'BANYUWANGI', areas), true);
  assert.equal(matchesDetailOfficeScope(unit, kc, 'Area Jember', 'BANYUWANGI', areas), true);
  assert.equal(matchesDetailOfficeScope(kcp, kc, 'Area Malang', 'BANYUWANGI', areas), false);
  assert.equal(matchesDetailOfficeScope(kcp, kc, 'Area Jember', 'JEMBER', areas), false);
  assert.equal(matchesDetailOfficeScope(kk, null, 'ALL', 'ALL', areas), true);
});

test('baris source-only mengikuti Nama Cabang yang tercatat tanpa membuat relasi induk kantor', () => {
  const areas = { 'Area Jember': ['Banyuwangi', 'Genteng'] };
  assert.equal(matchesDetailSourceScope('KC BANYUWANGI', 'Area Jember', 'BANYUWANGI', areas), true);
  assert.equal(matchesDetailSourceScope('KC BANYUWANGI', 'Area Malang', 'ALL', areas), false);
  assert.equal(matchesDetailSourceScope('KC BANYUWANGI', 'ALL', 'ROGOJAMPI', areas), false);
  const placeholder = createDetailOfficePlaceholder({ BRANCH: 'KK YAYASAN PUSPA DUNIA', 'BRANCH CODE': '009', 'BRANCH TYPE': 'KC' }, 'BANYUWANGI', {
    unitType: 'KK', sourceTypeConflict: true, noDetailMetricInSource: true,
  });
  assert.equal(placeholder.unitType, 'KK');
  assert.equal(placeholder.sourceTypeConflict, true);
  assert.equal(placeholder.noDetailMetricInSource, true);
});

test('kantor master tanpa metrik menjadi placeholder dan tetap membedakan nilai kosong dari nol', () => {
  const row = createDetailOfficePlaceholder(kcp, kc.BRANCH);
  assert.equal(row.kode_uker, '002');
  assert.equal(row.unitType, 'KCP');
  assert.equal(row.cabang, 'BANYUWANGI');
  assert.equal(row.synthetic, true);
  assert.equal(row.has_curr, false);
  assert.equal(row.curr, null);
  assert.equal(row.dtd_diff, null);
});

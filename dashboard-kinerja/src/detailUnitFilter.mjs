export const normalizeOfficeType = (value) => String(value ?? '').trim().toUpperCase();

export const getSourceOfficeType = (label) => {
  const match = /^(KCP|KK|KC|UNIT)(?:\s|$)/i.exec(String(label ?? '').trim());
  return match?.[1]?.toUpperCase() ?? null;
};

export const resolveDetailOfficeType = (office, sourceOfficeLabel) =>
  getSourceOfficeType(sourceOfficeLabel) || normalizeOfficeType(office?.['BRANCH TYPE']) || null;

const normalizeSourceBranchLabel = (value) => String(value ?? '').trim().replace(/^KC\s+/i, '')
  .replace(/\(KONSOLIDASI.*/i, '').replace(/-MDI.*/i, '').trim();

export const matchesSelectedOfficeType = (office, selectedType, sourceOfficeLabel) => {
  const normalizedSelection = normalizeOfficeType(selectedType);
  if (!normalizedSelection || normalizedSelection === 'ALL') return true;
  return resolveDetailOfficeType(office, sourceOfficeLabel) === normalizedSelection;
};

export const getOfficeKcCode = (office) => {
  const type = normalizeOfficeType(office?.['BRANCH TYPE']);
  const code = String(office?.['BRANCH CODE'] ?? '').trim();
  if (!code) return null;
  if (type === 'KC') return code;
  const mainBranchCode = String(office?.['MAIN BRANCH CODE'] ?? '').trim();
  return mainBranchCode || null;
};

export const matchesDetailOfficeScope = (office, parentKc, selectedArea, selectedBranch, areaMapping) => {
  const type = normalizeOfficeType(office?.['BRANCH TYPE']);
  const officeName = String(office?.BRANCH ?? '').trim();
  const branchName = String(type === 'KC' ? officeName : (parentKc?.BRANCH ?? officeName))
    .trim().replace(/^KC\s+/i, '').toUpperCase();
  const branchFilter = String(selectedBranch ?? 'ALL').trim().toUpperCase();
  if (branchFilter !== 'ALL' && !branchName.includes(branchFilter)) return false;

  const areaFilter = String(selectedArea ?? 'ALL').trim();
  if (areaFilter === 'ALL') return true;
  const areaNames = areaMapping?.[areaFilter];
  return Array.isArray(areaNames) && areaNames.some((name) => branchName.includes(String(name).trim().toUpperCase()));
};

export const matchesDetailSourceScope = (sourceBranchLabel, selectedArea, selectedBranch, areaMapping) => {
  const branchName = normalizeSourceBranchLabel(sourceBranchLabel).toUpperCase();
  const branchFilter = String(selectedBranch ?? 'ALL').trim().toUpperCase();
  if (branchFilter !== 'ALL' && !branchName.includes(branchFilter)) return false;
  const areaFilter = String(selectedArea ?? 'ALL').trim();
  if (areaFilter === 'ALL') return true;
  const areaNames = areaMapping?.[areaFilter];
  return Array.isArray(areaNames) && areaNames.some((name) => branchName.includes(String(name).trim().toUpperCase()));
};

export const createDetailOfficePlaceholder = (office, kcName, options = {}) => ({
  uker: String(office?.BRANCH ?? '').trim(),
  cabang: normalizeSourceBranchLabel(kcName ?? office?.BRANCH),
  kode_uker: String(office?.['BRANCH CODE'] ?? '').trim(),
  unitType: normalizeOfficeType(options.unitType ?? office?.['BRANCH TYPE']) || '—',
  sourceTypeConflict: options.sourceTypeConflict === true,
  mappingUnresolved: options.mappingUnresolved === true,
  noDetailMetricInSource: options.noDetailMetricInSource === true,
  synthetic: true,
  has_curr: false,
  has_prev: false,
  has_des25: false,
  has_d_min_1: false,
  curr: null,
  prev: null,
  des25: null,
  d_min_1: null,
  ytd_diff: null,
  mtd_diff: null,
  dtd_diff: null,
});

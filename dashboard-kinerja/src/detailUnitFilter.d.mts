export type OfficeMasterRecord = Record<string, unknown>;

export declare const normalizeOfficeType: (value: unknown) => string;
export declare const getSourceOfficeType: (label: unknown) => string | null;
export declare const resolveDetailOfficeType: (office: OfficeMasterRecord | null | undefined, sourceOfficeLabel?: unknown) => string | null;
export declare const matchesSelectedOfficeType: (office: OfficeMasterRecord | null | undefined, selectedType: string, sourceOfficeLabel?: unknown) => boolean;
export declare const getOfficeKcCode: (office: OfficeMasterRecord | null | undefined) => string | null;
export declare const matchesDetailOfficeScope: (
  office: OfficeMasterRecord,
  parentKc: OfficeMasterRecord | null | undefined,
  selectedArea: string,
  selectedBranch: string,
  areaMapping: Record<string, string[]>
) => boolean;
export declare const matchesDetailSourceScope: (
  sourceBranchLabel: unknown,
  selectedArea: string,
  selectedBranch: string,
  areaMapping: Record<string, string[]>
) => boolean;
export declare const createDetailOfficePlaceholder: (
  office: OfficeMasterRecord,
  kcName?: unknown,
  options?: { unitType?: string; sourceTypeConflict?: boolean; mappingUnresolved?: boolean; noDetailMetricInSource?: boolean }
) => {
  uker: string;
  cabang: string;
  kode_uker: string;
  unitType: string;
  sourceTypeConflict: boolean;
  mappingUnresolved: boolean;
  noDetailMetricInSource: boolean;
  synthetic: true;
  has_curr: false;
  has_prev: false;
  has_des25: false;
  has_d_min_1: false;
  curr: null;
  prev: null;
  des25: null;
  d_min_1: null;
  ytd_diff: null;
  mtd_diff: null;
  dtd_diff: null;
};

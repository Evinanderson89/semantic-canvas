import { feature } from "topojson-client";
import world from "world-atlas/countries-110m.json";

/**
 * ISO 3166-1 alpha-2 -> numeric, because world-atlas identifies countries by
 * numeric code while warehouses almost always store alpha-2. Matching on
 * country *names* instead is a well-known trap ("United States" vs "United
 * States of America" vs "USA").
 */
const A2_TO_NUM: Record<string, number> = {
  AD:20,AE:784,AF:4,AG:28,AL:8,AM:51,AO:24,AR:32,AT:40,AU:36,AZ:31,
  BA:70,BD:50,BE:56,BG:100,BR:76,BW:72,BY:112,
  CA:124,CH:756,CL:152,CN:156,CO:170,CR:188,CU:192,CY:196,CZ:203,
  DE:276,DK:208,DO:214,DZ:12,
  EC:218,EE:233,EG:818,ES:724,ET:231,
  FI:246,FJ:242,FR:250,
  GB:826,GE:268,GH:288,GR:300,GT:320,
  HK:344,HN:340,HR:191,HU:348,
  ID:360,IE:372,IL:376,IN:356,IQ:368,IR:364,IS:352,IT:380,
  JM:388,JO:400,JP:392,
  KE:404,KH:116,KR:410,KW:414,KZ:398,
  LB:422,LK:144,LT:440,LU:442,LV:428,
  MA:504,MD:498,MK:807,MM:104,MN:496,MT:470,MX:484,MY:458,
  NG:566,NL:528,NO:578,NP:524,NZ:554,
  OM:512,
  PA:591,PE:604,PH:608,PK:586,PL:616,PT:620,PY:600,
  QA:634,
  RO:642,RS:688,RU:643,
  SA:682,SE:752,SG:702,SI:705,SK:703,SN:686,
  TH:764,TN:788,TR:792,TW:158,TZ:834,
  UA:804,UG:800,US:840,UY:858,
  VE:862,VN:704,
  ZA:710,ZM:894,ZW:716,
};

const topo: any = world as any;
export const COUNTRIES: any = feature(topo, topo.objects.countries);
export const LAND_OUTLINE: any = { type: "Sphere" };

/** Resolve whatever the warehouse stored to a world-atlas feature id. */
export function toFeatureId(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  const up = s.toUpperCase();
  if (A2_TO_NUM[up] != null) return String(A2_TO_NUM[up]);
  if (/^\d{1,3}$/.test(s)) return String(Number(s));
  // Fall back to matching the atlas's own names, for warehouses that store them.
  const byName = COUNTRIES.features.find(
    (f: any) => String(f.properties?.name ?? "").toLowerCase() === s.toLowerCase());
  return byName ? String(byName.id) : null;
}

export function coverage(values: unknown[]): { matched: number; total: number } {
  const total = values.length;
  const matched = values.filter((v) => toFeatureId(v) !== null).length;
  return { matched, total };
}

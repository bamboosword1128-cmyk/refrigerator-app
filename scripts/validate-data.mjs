import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDir, "../..");
const specPath = resolve(workspaceRoot, "refrigerator-spec.json");
const spec = JSON.parse(await readFile(specPath, "utf8"));

const errors = [];
const warnings = [];
const makers = spec.makers || [];
const products = spec.products || [];
const comparison = spec.comparison || {};
const productSpecs = comparison.productSpecs || {};
const fields = comparison.fields || [];
const groups = comparison.groups || [];
const sources = comparison.catalogSources || [];

const duplicateValues = (values) => values.filter((value, index) => values.indexOf(value) !== index);
const makerIds = new Set(makers.map((maker) => maker.id));
const productIds = products.map((product) => product.id);
const productIdSet = new Set(productIds);
const sourceIds = new Set(sources.map((source) => source.id));
const groupIds = new Set(groups.map((group) => group.id));

for (const duplicate of new Set(duplicateValues(makers.map((maker) => maker.id)))) {
  errors.push(`メーカーIDが重複: ${duplicate}`);
}
for (const maker of makers) {
  // ロゴが未提供のメーカーは、アプリ側のテキストフォールバックを使う。
  if (maker.logo) {
    try {
      await access(resolve(workspaceRoot, "refrigerator-app/app", maker.logo));
    } catch {
      errors.push(`${maker.id}: ロゴ ${maker.logo} が存在しない`);
    }
  }
}
for (const duplicate of new Set(duplicateValues(productIds))) {
  errors.push(`商品IDが重複: ${duplicate}`);
}
for (const product of products) {
  if (!makerIds.has(product.makerId)) errors.push(`${product.id}: makerId ${product.makerId} が未登録`);
  if (!productSpecs[product.id]) errors.push(`${product.id}: comparison.productSpecs がない`);
}
for (const id of Object.keys(productSpecs)) {
  if (!productIdSet.has(id)) warnings.push(`${id}: products 側に対応する商品がない`);
}
for (const field of fields) {
  if (!groupIds.has(field.groupId)) errors.push(`${field.id}: groupId ${field.groupId} が未登録`);
}
for (const source of sources) {
  if (source.sourceFile) {
    try {
      await access(resolve(workspaceRoot, source.sourceFile));
    } catch {
      errors.push(`${source.id}: sourceFile ${source.sourceFile} が存在しない`);
    }
  } else if (!/^https:\/\//.test(source.sourceUrl || "")) {
    errors.push(`${source.id}: sourceFile または HTTPS の sourceUrl がない`);
  }
  if (!source.sourceType) errors.push(`${source.id}: sourceType がない`);
}

const normalizeModel = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
for (const inventory of comparison.inventoryModels || []) {
  const wanted = normalizeModel(inventory.inputModel);
  const matchedProduct = products.find((product) => {
    if (product.makerId !== inventory.makerId) return false;
    return [product.name, ...(product.aliases || [])]
      .map(normalizeModel)
      .some((candidate) => candidate === wanted || candidate.startsWith(wanted));
  });
  if (!matchedProduct) {
    errors.push(`追加リスト未収録: ${inventory.makerId}/${inventory.inputModel}`);
    continue;
  }
  if (inventory.sourceImage) {
    try {
      await access(resolve(workspaceRoot, inventory.sourceImage));
    } catch {
      errors.push(`${inventory.inputModel}: 元画像 ${inventory.sourceImage} が存在しない`);
    }
  }
  const inventorySpec = productSpecs[matchedProduct.id];
  for (const path of ["size.totalL", "size.widthMm", "size.depthMm", "size.heightMm", "energy.annualKwh"]) {
    const value = path.split(".").reduce((current, key) => current?.[key], inventorySpec);
    if (!Number.isFinite(value)) errors.push(`${inventory.inputModel}: 必須仕様 ${path} が未確認`);
  }
}

const getPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object);
const isUnknown = (field, value) => {
  if (value === null || value === undefined || value === "") return true;
  if (field.type === "list") return !Array.isArray(value) || value.length === 0;
  if (field.type === "capability") return value.available !== true && value.available !== false;
  return false;
};

const directFields = fields.filter((field) => field.path);
const keyDirectFields = directFields.filter((field) => field.key);
const unknownByField = new Map(directFields.map((field) => [field.id, 0]));
let unknownCells = 0;
let unknownKeyCells = 0;

const rangeChecks = [
  ["size.widthMm", 400, 1000],
  ["size.depthMm", 400, 1000],
  ["size.heightMm", 800, 2200],
  ["size.weightKg", 20, 200],
  ["size.totalL", 100, 800],
  ["size.fridgeL", 20, 500],
  ["size.freezerL", 10, 250],
  ["size.vegetableL", 0, 200],
  ["energy.annualKwh", 150, 650],
  ["energy.achievementPercent", 50, 250]
];

for (const product of products) {
  const data = productSpecs[product.id];
  if (!data) continue;

  for (const field of directFields) {
    const value = getPath(data, field.path);
    if (isUnknown(field, value)) {
      unknownCells += 1;
      if (field.key) unknownKeyCells += 1;
      unknownByField.set(field.id, unknownByField.get(field.id) + 1);
    }
    if (field.type === "capability" && value != null && ![true, false, null, undefined].includes(value.available)) {
      errors.push(`${product.id}/${field.id}: available は true / false / null のいずれかにする`);
    }
  }

  for (const [path, minimum, maximum] of rangeChecks) {
    const value = getPath(data, path);
    if (value != null && (!Number.isFinite(value) || value < minimum || value > maximum)) {
      errors.push(`${product.id}/${path}: ${value} が想定範囲 ${minimum}〜${maximum} 外`);
    }
  }

  const total = data.size?.totalL;
  for (const key of ["fridgeL", "freezerL", "independentFreezerL", "vegetableL", "iceL"]) {
    const value = data.size?.[key];
    if (total != null && value != null && value > total) errors.push(`${product.id}/size.${key}: 定格内容積を超えている`);
  }

  if (!data.source?.sourceId) {
    errors.push(`${product.id}: カタログ出典IDがない`);
  } else if (!sourceIds.has(data.source.sourceId)) {
    errors.push(`${product.id}: sourceId ${data.source.sourceId} が未登録`);
  }
  if (!data.source?.pages) warnings.push(`${product.id}: 確認ページがない`);
}

const populatedCells = directFields.length * products.length - unknownCells;
const completeness = directFields.length && products.length
  ? Math.round((populatedCells / (directFields.length * products.length)) * 1000) / 10
  : 0;
const keyCellCount = keyDirectFields.length * products.length;
const populatedKeyCells = keyCellCount - unknownKeyCells;
const keyCompleteness = keyCellCount
  ? Math.round((populatedKeyCells / keyCellCount) * 1000) / 10
  : 0;
const mainUnknowns = [...unknownByField.entries()]
  .filter(([, count]) => count > 0)
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 12)
  .map(([id, count]) => `${id}:${count}`)
  .join(", ");

console.log(`Data validation: ${errors.length ? "FAILED" : "PASSED"}`);
console.log(`makers=${makers.length}, products=${products.length}, groups=${groups.length}, fields=${fields.length}`);
console.log(`direct cells=${directFields.length * products.length}, known=${populatedCells}, unknown=${unknownCells}, completeness=${completeness}%`);
console.log(`key cells=${keyCellCount}, known=${populatedKeyCells}, unknown=${unknownKeyCells}, completeness=${keyCompleteness}%`);
console.log(`main unknown fields: ${mainUnknowns || "none"}`);
if (warnings.length) console.log(`warnings (${warnings.length}):\n- ${warnings.join("\n- ")}`);
if (errors.length) {
  console.error(`errors (${errors.length}):\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
}

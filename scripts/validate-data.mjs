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
const productSources = spec.sources || [];
const featureGroups = spec.featureGroups || [];

const duplicateValues = (values) => values.filter((value, index) => values.indexOf(value) !== index);
const makerIds = new Set(makers.map((maker) => maker.id));
const productIds = products.map((product) => product.id);
const productIdSet = new Set(productIds);
const sourceIds = new Set(sources.map((source) => source.id));
const groupIds = new Set(groups.map((group) => group.id));
const productSourceIds = new Set(productSources.map((source) => source.id));
const featureGroupIds = new Set(featureGroups.map((group) => group.id));
const normalizeFeatureName = (value) => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("ja")
  .replace(/[\s　・･／/（）()「」『』\-―ー、,。.:：+＋]/g, "");

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
  const featureNames = new Set();
  for (const feature of product.features || []) {
    if (!feature.name) errors.push(`${product.id}: 名前のないメーカー機能がある`);
    if (!feature.description) errors.push(`${product.id}/${feature.name}: 説明がない`);
    if (!featureGroupIds.has(feature.groupId)) errors.push(`${product.id}/${feature.name}: feature groupId ${feature.groupId} が未登録`);
    for (const sourceId of feature.sourceIds || []) {
      if (!productSourceIds.has(sourceId)) errors.push(`${product.id}/${feature.name}: product sourceId ${sourceId} が未登録`);
    }
    if (!(feature.sourceIds || []).length) errors.push(`${product.id}/${feature.name}: 出典IDがない`);
    const normalizedName = normalizeFeatureName(feature.name);
    if (featureNames.has(normalizedName)) errors.push(`${product.id}: メーカー機能が重複 ${feature.name}`);
    featureNames.add(normalizedName);
  }
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
  if (field.type === "featureSection") return !value || value.status === "unknown";
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
  ["size.chilledL", 0, 100],
  ["size.freezerL", 10, 250],
  ["size.independentFreezerL", 0, 150],
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
    if (field.type === "capability" && value?.available === true) {
      if (!value.featureName) {
        errors.push(`${product.id}/${field.id}: 搭載機能の正式名称がない`);
      } else if (/非搭載|なし$/.test(value.featureName)) {
        errors.push(`${product.id}/${field.id}: 搭載=true なのに非搭載を示す名称 ${value.featureName}`);
      } else if (!(product.features || []).some((feature) => normalizeFeatureName(feature.name) === normalizeFeatureName(value.featureName))) {
        errors.push(`${product.id}/${field.id}: 搭載機能 ${value.featureName} がメーカー機能欄に表示されない`);
      }
    }
    if (field.type === "featureSection" && value != null) {
      if (!["present", "absent", "unknown"].includes(value.status)) {
        errors.push(`${product.id}/${field.id}: status は present / absent / unknown のいずれかにする`);
      }
      if (!Array.isArray(value.items)) {
        errors.push(`${product.id}/${field.id}: items は配列にする`);
      } else {
        if (value.status === "present" && value.items.length === 0) errors.push(`${product.id}/${field.id}: present なのに項目がない`);
        if (value.status === "absent" && value.items.length > 0) errors.push(`${product.id}/${field.id}: absent なのに項目がある`);
        const itemNames = new Set();
        for (const item of value.items) {
          if (!item.name) errors.push(`${product.id}/${field.id}: 機能名がない`);
          if (!item.description) errors.push(`${product.id}/${field.id}/${item.name || "名称なし"}: 一言説明がない`);
          const normalizedName = normalizeFeatureName(item.name);
          if (itemNames.has(normalizedName)) errors.push(`${product.id}/${field.id}: 機能名が重複 ${item.name}`);
          itemNames.add(normalizedName);
        }
      }
    }
  }

  for (const [path, minimum, maximum] of rangeChecks) {
    const value = getPath(data, path);
    if (value != null && (!Number.isFinite(value) || value < minimum || value > maximum)) {
      errors.push(`${product.id}/${path}: ${value} が想定範囲 ${minimum}〜${maximum} 外`);
    }
  }

  const total = data.size?.totalL;
  for (const key of ["fridgeL", "chilledL", "freezerL", "independentFreezerL", "vegetableL", "iceL"]) {
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

const expectedOpeningFields = {
  basic: ["series", "release", "colors", "door-type"],
  size: ["width", "depth", "height", "weight", "fridge-capacity", "chilled-capacity", "freezer-capacity", "independent-freezer-capacity", "vegetable-capacity"],
  layout: ["center-room", "ice-room"],
  refrigeration: ["chilled-function", "fridge-storage", "door-pocket", "fridge-other"],
  freezing: ["special-freezing", "frost-control", "small-freezer", "freezer-storage", "freezer-other", "ice-room-functions"],
  vegetables: ["vegetable-freshness"],
  clean: ["clean-air", "maintenance"],
  energy: ["annual-energy", "annual-cost", "energy-ai"],
  smart: ["iot-connectivity", "iot-food", "iot-monitoring", "iot-ai"]
};
for (const [groupId, expectedIds] of Object.entries(expectedOpeningFields)) {
  const actualIds = fields.filter((field) => field.groupId === groupId).map((field) => field.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    errors.push(`${groupId}: 比較項目が指定順と不一致 ${JSON.stringify(actualIds)}`);
  }
}
const expectedGroups = [
  ["basic", "1. 基本情報"],
  ["size", "2. サイズ・容量"],
  ["layout", "3. レイアウト"],
  ["refrigeration", "4. 冷蔵機能"],
  ["freezing", "5. 冷凍機能"],
  ["vegetables", "6. 野菜保存"],
  ["clean", "7. 清潔・お手入れ"],
  ["energy", "8. 省エネ性"],
  ["smart", "9. スマホ連携・IoT"]
];
if (JSON.stringify(groups.map((group) => [group.id, group.label])) !== JSON.stringify(expectedGroups)) {
  errors.push(`比較カテゴリが指定順と不一致 ${JSON.stringify(groups.map((group) => [group.id, group.label]))}`);
}
const seriesField = fields.find((field) => field.id === "series");
if (!seriesField?.emptyForMakerIds?.includes("sharp")) errors.push("シャープのシリーズ名空欄指定がない");
for (const product of products) {
  const independentIce = productSpecs[product.id]?.layout?.independentIce;
  if (typeof independentIce !== "boolean") errors.push(`${product.id}/layout.independentIce: 製氷室は true / false で確定する`);
  const details = productSpecs[product.id]?.details;
  for (const item of details?.chilled?.items || []) {
    if (!item.description.includes("温度：") || !item.description.includes("保存目安：")) {
      errors.push(`${product.id}/details.chilled/${item.name}: 温度と肉・魚の保存目安が説明にない`);
    }
  }
  if (independentIce === false && details?.iceRoom?.status !== "absent") {
    errors.push(`${product.id}/details.iceRoom: 製氷室なしは absent にする`);
  }
  if (independentIce === true && details?.iceRoom?.status !== "present") {
    errors.push(`${product.id}/details.iceRoom: 製氷室ありは present にする`);
  }
}

// Regression guards for model-specific catalog bars that are easy to overgeneralize.
const findProduct = (makerId, model) => {
  const wanted = normalizeModel(model);
  return products.find((product) => product.makerId === makerId && [product.name, ...(product.aliases || [])].some((name) => normalizeModel(name) === wanted));
};
const expectValue = (makerId, model, path, expected, label) => {
  const product = findProduct(makerId, model);
  if (!product) {
    errors.push(`回帰チェック対象がない: ${makerId}/${model}`);
    return;
  }
  const actual = getPath(productSpecs[product.id], path);
  if (actual !== expected) errors.push(`${model}/${label}: 期待値 ${JSON.stringify(expected)} に対して ${JSON.stringify(actual)}`);
};
const expectCapability = (makerId, model, path, expectedAvailable, expectedNamePart) => {
  const product = findProduct(makerId, model);
  if (!product) {
    errors.push(`回帰チェック対象がない: ${makerId}/${model}`);
    return;
  }
  const actual = getPath(productSpecs[product.id], path);
  if (actual?.available !== expectedAvailable) errors.push(`${model}/${path}: available=${actual?.available}（期待 ${expectedAvailable}）`);
  if (expectedNamePart && !String(actual?.featureName || "").includes(expectedNamePart)) errors.push(`${model}/${path}: 名称 ${actual?.featureName || "なし"} に ${expectedNamePart} がない`);
};
const expectNoFeature = (makerId, model, featureNamePart) => {
  const product = findProduct(makerId, model);
  if (!product) {
    errors.push(`回帰チェック対象がない: ${makerId}/${model}`);
    return;
  }
  const found = (product.features || []).find((feature) => String(feature.name || "").includes(featureNamePart));
  if (found) errors.push(`${model}: 非搭載の機能 ${found.name} がメーカー機能欄にある`);
};

expectCapability("mitsubishi", "MR-BD46N", "smart.app", true, "三菱冷蔵庫アプリ");
expectCapability("mitsubishi", "MR-BD46N", "meatFish.freshness", true, "氷点下ストッカーD A.I.");
expectCapability("mitsubishi", "MR-MD45M", "smart.app", true, "三菱冷蔵庫アプリ");
expectCapability("mitsubishi", "MR-MD45N", "smart.app", true, "三菱冷蔵庫アプリ");
expectCapability("panasonic", "NR-F55HY3", "clean.antibacterial", true, "Wクリーンフィルター");
expectCapability("panasonic", "NR-F65WX3", "storage.adjustableShelves", true, "全棚ガラストレイ");
expectCapability("panasonic", "NR-F49EY3", "smart.foodManagement", true, "AIカメラ");
expectCapability("panasonic", "NR-E41RY3", "smart.foodManagement", true, "AIカメラ");
expectCapability("panasonic", "NR-F52BR3", "meatFish.freshness", true, "チルドルーム");
expectCapability("panasonic", "NR-F52BR3", "vegetables.freshness", true, "Wシャキシャキ野菜室プラス");
expectCapability("sharp", "SJ-X504R", "storage.doorAssist", true, "オートクローズ");
expectCapability("aqua", "AQR-TXA50A", "freezing.quality", true, "おいシールド冷凍");
expectCapability("aqua", "AQR-V46A", "meatFish.freshness", true, "フルワイドチルド");
expectCapability("hisense", "HR-GC360KW", "storage.foldingShelf", true, "折りたたみ可能棚");
expectCapability("toshiba", "GR-A500GT", "meatFish.freshness", true, "速鮮チルド");
expectCapability("toshiba", "GR-A500GT", "storage.doorAssist", true, "タッチオープン");
expectNoFeature("toshiba", "GR-A500GT", "Deliチルド");
expectNoFeature("toshiba", "GR-A500GT", "ブースト解凍");
expectValue("mitsubishi", "MR-BD46N", "meatFish.storageClass", "氷点下系", "保存区分");
expectValue("panasonic", "NR-F65WX3", "size.chilledL", 21, "チルドルーム容量");
expectValue("mitsubishi", "MR-WZ61N", "size.chilledL", 30, "チルドルーム容量");
expectValue("toshiba", "GR-A640XFS", "size.chilledL", 29, "チルドルーム容量");
expectValue("sharp", "SJ-MF61R", "size.chilledL", 22, "チルドルーム容量");
expectValue("aqua", "AQR-TZA52A", "size.chilledL", 18, "チルドルーム容量");

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


export function normalizeRole(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isAdminRole(value) {
  const role = normalizeRole(value);
  return ['admin', 'administrator', 'super_admin', 'superadmin', 'owner', 'shop_admin', 'shop-admin'].includes(role);
}

export function isPharmacistRole(value) {
  return normalizeRole(value) === 'pharmacist';
}

export function canReceiveStock(value) {
  return isAdminRole(value) || isPharmacistRole(value);
}

export const canManageStockedDrugs = canReceiveStock;

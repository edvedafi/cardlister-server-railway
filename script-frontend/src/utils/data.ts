export const isYes = (str) =>
  (typeof str === 'boolean' && str) ||
  (typeof str === 'string' && ['yes', 'YES', 'y', 'Y', 'Yes', 'YEs', 'YeS', 'yES'].includes(str));

export const isNo = (str) =>
  (typeof str === 'boolean' && !str) || (typeof str === 'string' && ['no', 'NO', 'n', 'N', 'No'].includes(str));

export const psaGrades = {
  10: 'GEM-MT',
  9.5: 'MINT',
  9: 'MINT',
  8.5: 'NM-MT',
  8: 'NM-MT',
  7.5: 'NM',
  7: 'NM',
  6.5: 'EX-MT',
  6: 'EX-MT',
  5.5: 'EX',
  5: 'EX',
  4.5: 'VG-EX',
  4: 'VG-EX',
  3.5: 'VG',
  3: 'VG',
  2.5: 'G',
  2: 'G',
  1.5: 'PF',
  1: 'PF',
  0.5: 'PF',
  0: 'PO',
};

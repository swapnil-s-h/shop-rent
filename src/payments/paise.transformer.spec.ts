import { paiseTransformer } from './paise.transformer';

describe('paiseTransformer', () => {
  it('converts BIGINT strings from the database to numbers', () => {
    expect(paiseTransformer.from('1000000')).toBe(1_000_000);
    expect(paiseTransformer.from('-250')).toBe(-250);
    expect(paiseTransformer.from('0')).toBe(0);
  });

  it('passes null and undefined through', () => {
    expect(paiseTransformer.from(null)).toBeNull();
    expect(paiseTransformer.to(null)).toBeNull();
    expect(paiseTransformer.to(undefined)).toBeUndefined();
  });

  it('accepts integers when writing', () => {
    expect(paiseTransformer.to(1_000_000)).toBe(1_000_000);
  });

  it('rejects fractional, NaN and unsafe values instead of rounding them', () => {
    expect(() => {
      paiseTransformer.to(10.5);
    }).toThrow(/safe integer/);
    expect(() => {
      paiseTransformer.to(Number.NaN);
    }).toThrow(/safe integer/);
    expect(() => {
      paiseTransformer.to(2 ** 60);
    }).toThrow(/safe integer/);
    expect(() => {
      paiseTransformer.from('9007199254740993');
    }).toThrow(/safe integer/);
    expect(() => {
      paiseTransformer.from('12.5');
    }).toThrow(/safe integer/);
  });
});

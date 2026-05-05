import { describe, it, expect, beforeEach } from 'vitest';
import {
  divisionForChannel,
  roleForChannel,
  _resetCacheForTesting,
} from './division-lookup';

describe('division-lookup', () => {
  beforeEach(() => {
    _resetCacheForTesting();
  });

  describe('divisionForChannel', () => {
    it('returns BD for the BD intake channel', () => {
      expect(divisionForChannel('C0B1P92785C')).toBe('BD');
    });

    it('returns P2 for the P2 intake channel', () => {
      expect(divisionForChannel('C0B1S1ASKT4')).toBe('P2');
    });

    it('returns CX/Core for the core intake channel', () => {
      expect(divisionForChannel('C0B1JV1RX0B')).toBe('CX/Core');
    });

    it('returns Corporate for the corporate intake channel', () => {
      expect(divisionForChannel('C0B19STFLS3')).toBe('Corporate');
    });

    it('returns Product for the product intake channel', () => {
      expect(divisionForChannel('C0B1UUJ2C4C')).toBe('Product');
    });

    it('returns null for the alerts channel', () => {
      expect(divisionForChannel('C0ACWP7PGHE')).toBeNull();
    });

    it('returns null for the test channel', () => {
      expect(divisionForChannel('C0ABY48HRDL')).toBeNull();
    });

    it('returns null for an unknown channel', () => {
      expect(divisionForChannel('CNOTACONFIGURED')).toBeNull();
    });
  });

  describe('roleForChannel', () => {
    it('returns intake for division channels', () => {
      expect(roleForChannel('C0B1P92785C')).toBe('intake');
      expect(roleForChannel('C0B1S1ASKT4')).toBe('intake');
      expect(roleForChannel('C0B1JV1RX0B')).toBe('intake');
      expect(roleForChannel('C0B19STFLS3')).toBe('intake');
      expect(roleForChannel('C0B1UUJ2C4C')).toBe('intake');
    });

    it('returns alerts for the marketing alerts channel', () => {
      expect(roleForChannel('C0ACWP7PGHE')).toBe('alerts');
    });

    it('returns test for the dev/test channel', () => {
      expect(roleForChannel('C0ABY48HRDL')).toBe('test');
    });

    it('returns null for an unknown channel', () => {
      expect(roleForChannel('CNOTACONFIGURED')).toBeNull();
    });
  });

  describe('cache behavior', () => {
    it('returns the same result on repeated calls without re-reading', () => {
      const first = roleForChannel('C0B1P92785C');
      const second = roleForChannel('C0B1P92785C');
      expect(first).toBe(second);
      expect(first).toBe('intake');
    });
  });
});

import {expect,it} from 'vitest';
import {formatOriginalReductionPercent} from '@/lib/copy-follower-adjustment';
it('preserves the exact original fraction, including merged and tiny reductions',()=>{
 expect(formatOriginalReductionPercent('0.25')).toBe('25%');
 expect(formatOriginalReductionPercent('0.4375')).toBe('43.75%');
 expect(formatOriginalReductionPercent('0.000000000000000001')).toBe('0.0000000000000001%');
 expect(formatOriginalReductionPercent('0.999999999999999999')).toBe('99.9999999999999999%');
});

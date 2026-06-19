import { config } from '../config.ts';
import { liveKnob } from './live-knob.ts';

/**
 * Live toggle for automatic withdrawal approval (admin-tunable, no redeploy). Default = the boot env
 * `WITHDRAWAL_AUTO_PROCESS`. When OFF, the worker loop no-ops and every withdrawal waits for manual
 * operator approval; when ON, the worker auto-processes eligible (under the auto-approve cap) withdrawals.
 * Settings-backed via liveKnob so all instances converge on an admin change within the ~30s refresh.
 */
const autoProcess = liveKnob('withdrawal_auto_process', config.withdrawalAutoProcess, (v) => v === true || v === 'true');

export const getWithdrawalAutoProcess = autoProcess.get;
export const loadWithdrawalAutoProcess = autoProcess.load;
export const setWithdrawalAutoProcess = autoProcess.set;
export const withdrawalAutoProcessView = (): { enabled: boolean; default: boolean } => ({
  enabled: autoProcess.get(),
  default: autoProcess.default,
});

import React, { createContext, useContext } from 'react';
import { SLOW_THRESHOLD_MS as DEFAULT_SLOW_THRESHOLD_MS } from './constants';

// User-configurable "slow" threshold in milliseconds. Default mirrors the
// historical constant so anything that renders outside the provider (tests,
// stray usages) keeps prior behavior.
const SlowThresholdContext = createContext<number>(DEFAULT_SLOW_THRESHOLD_MS);

export const SlowThresholdProvider = SlowThresholdContext.Provider;
export const useSlowThreshold = () => useContext(SlowThresholdContext);
export { DEFAULT_SLOW_THRESHOLD_MS };

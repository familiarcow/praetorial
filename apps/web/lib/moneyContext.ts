// FE16b (S18): "can we trust the money on screen?" for every screen. True (= stale) while offline, after a failed contract view,
// or when the page is out of date. Provided once in App.tsx.
import { createContext, useContext } from "react";
export const MoneyStaleContext = createContext(false);
export const useMoneyStale = () => useContext(MoneyStaleContext);

package subscriptions

import (
	"math"
	"slices"
	"strings"
)

// CurrencyCodes are the lowercase ISO codes from the runtime's CLDR catalog (the TypeScript
// currency.ts list); Stripe availability varies by account.
var CurrencyCodes = []string{"aed", "afn", "all", "amd", "ang", "aoa", "ars", "aud", "awg", "azn", "bam", "bbd", "bdt", "bgn", "bhd", "bif", "bmd", "bnd", "bob", "brl", "bsd", "btn", "bwp", "byn", "bzd", "cad", "cdf", "chf", "clp", "cny", "cop", "crc", "cuc", "cup", "cve", "czk", "djf", "dkk", "dop", "dzd", "egp", "ern", "etb", "eur", "fjd", "fkp", "gbp", "gel", "ghs", "gip", "gmd", "gnf", "gtq", "gyd", "hkd", "hnl", "hrk", "htg", "huf", "idr", "ils", "inr", "iqd", "irr", "isk", "jmd", "jod", "jpy", "kes", "kgs", "khr", "kmf", "kpw", "krw", "kwd", "kyd", "kzt", "lak", "lbp", "lkr", "lrd", "lsl", "lyd", "mad", "mdl", "mga", "mkd", "mmk", "mnt", "mop", "mru", "mur", "mvr", "mwk", "mxn", "myr", "mzn", "nad", "ngn", "nio", "nok", "npr", "nzd", "omr", "pab", "pen", "pgk", "php", "pkr", "pln", "pyg", "qar", "ron", "rsd", "rub", "rwf", "sar", "sbd", "scr", "sdg", "sek", "sgd", "shp", "sle", "sll", "sos", "srd", "ssp", "stn", "svc", "syp", "szl", "thb", "tjs", "tmt", "tnd", "top", "try", "ttd", "twd", "tzs", "uah", "ugx", "usd", "uyu", "uzs", "ves", "vnd", "vuv", "wst", "xaf", "xcd", "xcg", "xdr", "xof", "xpf", "xsu", "yer", "zar", "zmw", "zwg", "zwl"}

var (
	zeroDecimal  = []string{"bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"}
	threeDecimal = []string{"bhd", "iqd", "jod", "kwd", "lyd", "omr", "tnd"}
	// hundreds are Stripe's backwards-compatible charge units: 2 decimals, whole major units.
	hundreds = []string{"isk", "ugx"}
)

// ValidCurrency reports whether code is a lowercase code of the catalog ("USD" is not).
func ValidCurrency(code string) bool { return slices.Contains(CurrencyCodes, code) }

// CurrencyDecimals returns the Stripe minor-unit decimals of a code (any case): 0, 3, or 2
// (also for unknown codes).
func CurrencyDecimals(code string) int {
	code = strings.ToLower(code)
	switch {
	case slices.Contains(zeroDecimal, code):
		return 0
	case slices.Contains(threeDecimal, code):
		return 3
	}
	return 2
}

// ValidMinorAmount reports whether amount is a safe integer >= 0 and, for isk and ugx (any
// case), a multiple of 100.
func ValidMinorAmount(amount float64, code string) bool {
	return safeFloat(amount) && amount >= 0 && (!slices.Contains(hundreds, strings.ToLower(code)) || math.Mod(amount, 100) == 0)
}

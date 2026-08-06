# html-jsx-typeerror

A minimal HTML-entry project whose TypeScript does not type-check. `ts0 build`
MUST fail on it: HTML entries were once exempt from type-checking and reported
success regardless, which is exactly the regression this sample catches.

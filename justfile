# The package's own binaries come first on PATH, as npm run puts them.
export PATH := justfile_directory() + "/node_modules/.bin:" + env_var("PATH")

# The npm script build.
build:
	node --experimental-strip-types src/cli.ts build

# The npm script build:prebuilt.
build-prebuilt:
	node --experimental-strip-types scripts/build-prebuilt.ts

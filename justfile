# run local dev env
dev: install
  pnpm dev

# install all node dependencies, via pnpm
install:
  pnpm install

# build all sources
build:
  pnpm turbo build

# run tests
test:
  pnpm turbo test

# build the documentation book (output in docs/book, which is not committed)
docs:
  mdbook build docs

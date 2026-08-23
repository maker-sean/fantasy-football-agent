-- What the cache actually saved.
--
-- model_usage recorded input_tokens and output_tokens and nothing else, so
-- every cached read was billed at full price in any arithmetic done over this
-- table. src/answer.js has cached PERSONA since it was written, which means the
-- numbers have always been overstated and there was no way to see by how much.
--
-- Cached reads are about a tenth of the input price and cache writes about
-- 1.25x, so without these two columns "cost" is a guess with a known bias and
-- no way to size it.
alter table model_usage
  add column if not exists cache_read_input_tokens     int not null default 0,
  add column if not exists cache_creation_input_tokens int not null default 0;

comment on column model_usage.cache_read_input_tokens is
  'Served from the prompt cache, billed at roughly a tenth of input. Zero across repeated calls means a silent cache invalidator.';
comment on column model_usage.cache_creation_input_tokens is
  'Written to the cache, billed at roughly 1.25x input. Paid once per prefix.';

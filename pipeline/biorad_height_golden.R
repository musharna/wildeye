# Second engine for the flight-height quantiles in pipeline/vol2bird.py: bioRad's own
# integrate_profile(height_quantile = q) on each vol2bird stdout profile.
# Usage: Rscript pipeline/biorad_height_golden.R RADAR OUT_CSV PROFILE.txt [PROFILE.txt ...]
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 3) stop("usage: biorad_height_golden.R RADAR OUT_CSV PROFILE.txt ...")
suppressPackageStartupMessages(library(bioRad))
cat_file <- tempfile(fileext = ".txt")
writeLines(unlist(lapply(args[-(1:2)], readLines)), cat_file)
ts <- read_stdout(cat_file, radar = args[1], wavelength = "S")
q <- function(i, p) integrate_profile(ts[i], height_quantile = p)$height
out <- data.frame(datetime = format(ts$datetime, "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
                  q25 = sapply(seq_along(ts$datetime), function(i) sprintf("%.17g", q(i, 0.25))),
                  q50 = sapply(seq_along(ts$datetime), function(i) sprintf("%.17g", q(i, 0.50))),
                  q75 = sapply(seq_along(ts$datetime), function(i) sprintf("%.17g", q(i, 0.75))))
writeLines(c(paste0("# bioRad ", packageVersion("bioRad"), " integrate_profile(height_quantile = 0.25, 0.5, 0.75), m above sea level"),
             paste(names(out), collapse = ",")), args[2])
write.table(out, args[2], sep = ",", quote = FALSE, row.names = FALSE, col.names = FALSE, append = TRUE)

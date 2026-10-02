# BioTIME 2.0 .rds -> gzipped CSV of the six columns pipeline/biotime.py counts, sorted by study then year.
# A format step only: every count and every decision is made in Python. Base R only, so any host with R can run it.
# Usage: Rscript --vanilla biotime_extract.R in.rds out.csv.gz
args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2) stop("usage: Rscript biotime_extract.R in.rds out.csv.gz")
cols <- c("STUDY_ID", "YEAR", "SAMPLE_DESC", "LATITUDE", "LONGITUDE", "valid_name")
x <- readRDS(args[1])
missing <- setdiff(cols, names(x))
if (length(missing)) stop("the .rds lacks columns: ", paste(missing, collapse = ", "))
x <- x[order(x$STUDY_ID, x$YEAR, method = "radix"), cols]
con <- gzfile(args[2], "w")
write.csv(x, con, row.names = FALSE, na = "NA")
close(con)
cat("wrote", nrow(x), "records to", args[2], "\n")

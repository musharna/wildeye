# BioTIME 2.0 .rds -> gzipped CSV of the six columns pipeline/biotime.py counts, sorted by study then year.
# A format step only: every count and every decision is made in Python. Usage: Rscript biotime_extract.R in.rds out.csv.gz
suppressMessages(library(data.table))
args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2) stop("usage: Rscript biotime_extract.R in.rds out.csv.gz")
cols <- c("STUDY_ID", "YEAR", "SAMPLE_DESC", "LATITUDE", "LONGITUDE", "valid_name")
x <- as.data.table(readRDS(args[1]))
missing <- setdiff(cols, names(x))
if (length(missing)) stop("the .rds lacks columns: ", paste(missing, collapse = ", "))
x <- x[, ..cols]
setorderv(x, c("STUDY_ID", "YEAR"))
fwrite(x, args[2], compress = "gzip", na = "NA")
cat("wrote", nrow(x), "records to", args[2], "\n")

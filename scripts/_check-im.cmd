@echo off
echo CHECK_IM_START
where magick >%%TEMP%%\magick-where.txt 2>&1
echo WHERE_EXIT=%errorlevel%
type %%TEMP%%\magick-where.txt
echo CHECK_IM_DONE

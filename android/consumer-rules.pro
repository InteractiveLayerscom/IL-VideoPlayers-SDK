# Applied to apps that use this library. IMA and Google Mobile Ads are optional (compileOnly): an app that
# does not add them must still shrink with R8. AdPlanIma and AdPlanGma are only loaded when the app has them.
-dontwarn androidx.media3.exoplayer.ima.**
-dontwarn com.google.ads.interactivemedia.**
-dontwarn com.google.android.gms.ads.**

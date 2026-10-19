plugins {
    id("com.android.application")
}

android {
    namespace = "dev.selfstreamdeck"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.selfstreamdeck"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

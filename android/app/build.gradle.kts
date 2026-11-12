plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "dev.selfstreamdeck"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.selfstreamdeck"
        minSdk = 24
        targetSdk = 34
        // the version of the whole project (agent/Cargo.toml); the code is major*10000 + minor*100 + patch. tools/version-check keeps them equal
        versionCode = 107
        versionName = "0.1.7"
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

    kotlinOptions {
        jvmTarget = "17"
    }
}

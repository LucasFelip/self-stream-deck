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

    // The release build is signed when the keystore is given in the environment (a release workflow, or the owner's PC); without it the
    // release APK comes out unsigned and the debug build is the one to install. The key never lives in the repository.
    val keystore = System.getenv("SSD_KEYSTORE")?.takeIf { it.isNotBlank() }
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = System.getenv("SSD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SSD_KEY_ALIAS")
                keyPassword = System.getenv("SSD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // the app is a thin shell around a WebView with a JavaScript bridge: shrinking saves little and needs keep rules
            isMinifyEnabled = false
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
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

dependencies {
    // the app itself depends on nothing; this is for the tests of app/src/test
    testImplementation(libs.junit)
}

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.happyrun.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.happyrun.tv"
        minSdk = 21
        targetSdk = 34
        versionCode = 6
        versionName = "1.5"
    }

    // 签名：使用 CI 缓存生成的稳定调试密钥（无任何密钥入库）。
    // 如需正式签名：把密钥放到 ~/.android/debug.keystore 或改用
    // ANDROID_KEYSTORE_BASE64 解码产物（见 tv-app/README.md）。
    signingConfigs {
        create("release") {
            storeFile = file(System.getProperty("user.home") + "/.android/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
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

// 零第三方依赖：纯 android SDK + kotlin-stdlib（由 KGP 自动引入）
dependencies {}

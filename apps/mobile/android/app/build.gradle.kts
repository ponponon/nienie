import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Release 签名材料：android/key.properties（本地，已 gitignore）或 CI 里由 Secrets 生成。
// storeFile 支持绝对路径（CI）与相对模块路径（本地）。
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
}

android {
    namespace = "cn.quniv.nienie_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "cn.quniv.nienie_mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // 只打 arm64-v8a：现代 Android 机器（2016 年后）均为 64 位，
        // 砍掉 armeabi-v7a / x86_64 三份 Flutter 引擎后 APK 体积可降 50% 以上。
        ndk {
            abiFilters.clear()
            abiFilters.add("arm64-v8a")
        }
    }

    // 让 .so 在 APK 内以压缩形式存放（仅影响独立 APK，不影响 App Bundle）
    packagingOptions {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // 有 key.properties 就用正式密钥；没有则退回 debug 签名（保证本地无凭据也能 flutter run --release）
            signingConfig = if (keystorePropertiesFile.exists()) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

// 发布构建（assembleRelease / bundleRelease）必须使用正式密钥：
// 缺少 key.properties 时直接失败，避免把 debug 签名的包发给用户。
tasks.configureEach {
    if (name == "bundleRelease" || name == "assembleRelease") {
        doFirst {
            if (!keystorePropertiesFile.exists()) {
                throw GradleException(
                    "Release signing is not configured. Create apps/mobile/android/key.properties " +
                        "(local) or let CI inject it from Secrets; see docs/distribution/macos-dmg-release.md."
                )
            }
            val storeFilePath = keystoreProperties.getProperty("storeFile")
                ?: throw GradleException("Missing storeFile in key.properties")
            if (!file(storeFilePath).isFile) {
                throw GradleException("Keystore not found: $storeFilePath")
            }
        }
    }
}

flutter {
    source = "../.."
}

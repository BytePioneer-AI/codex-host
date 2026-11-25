import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.serialization")
}

val releaseVersion = (JsonSlurper().parse(rootProject.file("../../package.json")) as Map<*, *>)["version"] as String
val (major, minor, patch) = releaseVersion.substringBefore('-').split('.').map(String::toInt)
require(major in 0..2099 && minor in 0..999 && patch in 0..999)

android {
    namespace = "ai.bytepioneer.codexhost.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "ai.bytepioneer.codexhost.android"
        minSdk = 26
        targetSdk = 35
        versionCode = (major * 1_000_000 + minor * 1_000 + patch).coerceAtLeast(1)
        versionName = releaseVersion
    }

    val keystoreFilePath = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() }
    val keystorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() }
    val keyAliasName = System.getenv("ANDROID_KEY_ALIAS")?.takeIf { it.isNotBlank() }
    val keyPasswordValue = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotBlank() }
    val hasReleaseSigning =
        keystoreFilePath != null &&
            keystorePassword != null &&
            keyAliasName != null &&
            keyPasswordValue != null

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystoreFilePath!!)
                storePassword = keystorePassword
                keyAlias = keyAliasName
                keyPassword = keyPasswordValue
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.constraintlayout:constraintlayout:2.2.1")
    implementation("androidx.recyclerview:recyclerview:1.4.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.camera:camera-camera2:1.4.2")
    implementation("androidx.camera:camera-lifecycle:1.4.2")
    implementation("androidx.camera:camera-view:1.4.2")
    implementation("com.google.zxing:core:3.5.3")
    implementation("androidx.security:security-crypto:1.1.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.8.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

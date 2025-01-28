#!/bin/bash
# Usage: ./build.sh [template-file]
# Description:
# Build the wrangler.toml configuration file from a template and environment variables.
# If no template-file is provided, the default is wrangler.template.toml.
# The script will generate a wrangler.toml file based on the provided template file
# by subsituting any environment variables referenced in the template, e.g.
#     ${VARIABLE}.
# Additionally, all environment variables named beginning with `WRANGLER_VARS_`
# will be appended to the generated file, assumed to be the final "[vars]" section.
# I.e. for a variable `WRANGLER_VARS_{VARIABLE}` with value `{VALUE}`, the script
# will append the line:
#     {VARIABLE} = "{VALUE}"
#
set -euo pipefail

# Default template file
WranglerTemplateFile="wrangler.template.toml"

# Check if a template file was provided as an argument
if [ $# -eq 1 ]; then
    WranglerTemplateFile="$1"
fi
if [ ! -r "${WranglerTemplateFile}" ]; then
    echo "❌ Error: Template file '${WranglerTemplateFile}' is not readable" >&2
    exit 1
fi

RequiredVarsArray=(
    "WRANGLER_NAME"
)

# Validate core required variables
for var in "${RequiredVarsArray[@]}"; do
    if [ -z "${!var:-}" ]; then
        echo "❌ Error: Required environment variable $var is not set" >&2
        exit 1
    fi
done

# Perform subsitution of all environment variables in the template file
IFS="," echo "📝 Generating wrangler.toml from ${WranglerTemplateFile} by subsituting all environment variables, including those required (${RequiredVarsArray[*]})..."
envsubst < "${WranglerTemplateFile}" | \
{
    # Check if WRANGLER_KV_MAP_ID is set, and exclude the KV MAP namespace configuration if not
    if [ -z "${WRANGLER_KV_MAP_ID:-}" ]; then
        echo "ℹ️ WRANGLER_KV_MAP_ID not set, excluding KV namespace configuration" >&2
        grep -v "^kv_namespaces ="
    else
        echo "✓ Keeping KV MAP namespace configuration" >&2
        cat
    fi >wrangler.toml
} 2>&1

# Append WRANGLER_VARS_ variables in alphabetical order
echo "📝 Appending WRANGLER_VARS_* variables..."
env | grep '^WRANGLER_VARS_' | sort | while IFS='=' read -r name value; do
    # Extract the variable name after WRANGLER_VARS_ prefix
    var_name=${name#WRANGLER_VARS_}
    # Append to wrangler.toml, keeping the quotes from the original value
    echo "$var_name = \"$value\"" >> wrangler.toml
done

echo "✅ Successfully generated wrangler.toml"

#echo "🔍 Generated configuration:"
#cat wrangler.toml
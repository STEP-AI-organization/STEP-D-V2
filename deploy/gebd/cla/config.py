import json

FILE_LIST = './../data/dataset_split_list.json'
ANNOTATION_PATH = './../data/all_data.json'

DATA_PATH = '.'
MODEL_SAVE_PATH = './models/'

DEVICE = 'cuda'

#USE_FEATURE=['tsn', 'slowfast']
USE_FEATURE=['tsn']
FEATURE_DIM = 0
for FEATURE in USE_FEATURE:
    if FEATURE == 'tsn':
        FEATURE_DIM += 2048
    if FEATURE == 'slowfast':
        FEATURE_DIM += 2304 

FEATURE_LEN = 300 # DO NOT CHANGE
TIME_UNIT = 1 # DO NOT CHANGE

GAP = 16 # VALID LOCAL RANGE
CHANNEL_NUM = 4 
ENCODER_HIDDEN = 512 
DECODER_HIDDEN = 128

EVENT_LOSS_COEF = 0.5 
SHOT_LOSS_COEF = 0.2
WHOLE_LOSS_COEF = 0.3

AUX_LOSS_COEF = 0.5   

BATCH_SIZE = 8
LEARNING_RATE = 1e-4
DROP_RATE = 0.2

GLUE_PROB = 0.3 # Probability of glueing augmentation 
INTERPOLATION_PROB = 0.2 # Probability of data of DATA_PATH_2

THRESHOLD = 0.1 # Minimum score to be event boundary
SIGMA_LIST = [-1, 0.4] # List of sigma values of gaussian filtering in validation
TEST_THRESHOLD = 0.35
GOAL_SCORE = 0.815 # Train ends when validation score gets here

#PATIENCE = 15 # Patience for early stopping
PATIENCE = 20 # Patience for early stopping

NUM_WORKERS = 4


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--FILE_LIST')
    parser.add_argument('--ANNOTATION_PATH')
    args = parser.parse_args()
    args = vars(args)
    arg_keys = list(args.keys())

    with open(__file__, 'r') as f:
        lines = f.readlines()

    for i in range(len(lines)):
        line = lines[i]
        try:
            key, value = line.split('=')
            key = key.strip()
        except ValueError as e:
            continue

        if key in arg_keys:
            if args[key] is not None:
                print(f'- {lines[i]}', end='')
                lines[i] = f"{key} = '{args[key]}'\n"
                print(f'+ {lines[i]}', end='')

    with open(__file__, 'w') as f:
        for line in lines:
            f.write(line)
